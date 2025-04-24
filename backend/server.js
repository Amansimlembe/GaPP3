require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const redis = require('./redis');
const winston = require('winston');
const fs = require('fs');
const { router: authRoutes, authMiddleware } = require('./routes/auth');
const socialRoutes = require('./routes/social');
const jobseekerRoutes = require('./routes/jobseeker');
const employerRoutes = require('./routes/employer');

const app = express();
app.set('trust proxy', 1);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://gapp-6yc3.onrender.com', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});
app.set('io', io);

app.use(cors({
  origin: ['https://gapp-6yc3.onrender.com', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

// Serve static files from frontend/build
const buildPath = path.join(__dirname, '..', 'frontend', 'build'); // Points to frontend/build
logger.info(`Attempting to serve static files from: ${buildPath}`);
if (fs.existsSync(buildPath)) {
  try {
    const buildFiles = fs.readdirSync(buildPath);
    logger.info(`Build directory contents: ${buildFiles.join(', ')}`);
    app.use(express.static(buildPath));
  } catch (err) {
    logger.error(`Failed to read build directory: ${buildPath}`, { error: err.message });
    app.use(express.static(path.join(__dirname, '..', 'frontend', 'public'))); // Fallback to frontend/public
  }
} else {
  logger.warn(`Build directory not found: ${buildPath}, falling back to frontend/public`);
  app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

// JSON parsing error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.error('Invalid JSON payload', { method: req.method, url: req.url, body: req.body, error: err.message });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error('MongoDB connection error:', { error: err.message, stack: err.stack });
    process.exit(1);
  }
};
connectDB();

// Route setup with guards
const routes = [
  { path: '/auth', handler: authRoutes },
  { path: '/jobseeker', handler: jobseekerRoutes },
  { path: '/employer', handler: employerRoutes },
  { path: '/social', handler: socialRoutes(io) },
];

routes.forEach(({ path, handler }) => {
  if (handler && typeof handler === 'function') {
    app.use(path, handler);
  } else {
    logger.error(`Invalid route handler for ${path}`);
  }
});

// Fallback for client-side routing
app.get('*', (req, res) => {
  const indexPath = fs.existsSync(buildPath)
    ? path.join(buildPath, 'index.html')
    : path.join(__dirname, '..', 'frontend', 'public', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      logger.error('Failed to serve index.html', { path: indexPath, error: err.message });
      res.status(500).json({ error: 'Server Error - Static files may not be available' });
    }
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal Server Error' });
});

io.on('connection', (socket) => {
  logger.info('User connected', { socketId: socket.id });

  socket.on('join', (userId) => {
    socket.join(userId);
    logger.info('User joined room', { userId, socketId: socket.id });
  });

  socket.on('disconnect', () => {
    logger.info('User disconnected', { socketId: socket.id });
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => logger.info(`Server running on port ${PORT}`));

const shutdown = async () => {
  logger.info('Shutting down server');
  try {
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logger.error('Error closing Redis connection during shutdown', { error: err.message });
  }
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error('Error closing MongoDB connection during shutdown', { error: err.message });
  }
  io.close(() => {
    logger.info('Socket.IO connections closed');
  });
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);