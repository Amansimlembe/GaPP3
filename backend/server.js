require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const winston = require('winston');
const fs = require('fs');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

let authRoutes, authMiddleware, socialRoutes, jobseekerRoutes, employerRoutes;
try {
  ({ router: authRoutes, authMiddleware } = require('./routes/auth'));
  socialRoutes = require('./routes/social');
  jobseekerRoutes = require('./routes/jobseeker');
  employerRoutes = require('./routes/employer');
} catch (err) {
  logger.error('Failed to load route modules', { error: err.message, stack: err.stack });
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://gapp-6yc3.onrender.com', 'http://localhost:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});
app.set('io', io);

app.use(cors({
  origin: ['https://gapp-6yc3.onrender.com', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

const buildPath = path.join(__dirname, '..', 'frontend', 'build');
logger.info(`Attempting to serve static files from: ${buildPath}`);
if (fs.existsSync(buildPath)) {
  try {
    const buildFiles = fs.readdirSync(buildPath);
    logger.info(`Build directory contents: ${buildFiles.join(', ')}`);
    app.use(express.static(buildPath));
  } catch (err) {
    logger.error(`Failed to read build directory: ${buildPath}`, { error: err.message });
    process.exit(1);
  }
} else {
  logger.error(`Build directory not found: ${buildPath}`);
  process.exit(1);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

// DNS test endpoint
app.get('/test-dns', async (req, res) => {
  const dns = require('dns').promises;
  try {
    const addresses = await dns.resolve4('redis-16680.c341.af-south-1-1.ec2.redns.redis-cloud.com');
    logger.info('DNS resolution successful', { host: 'redis-16680.c341.af-south-1-1.ec2.redns.redis-cloud.com', addresses });
    res.json({ status: 'success', addresses });
  } catch (err) {
    logger.error('DNS resolution test failed', { host: 'redis-16680.c341.af-south-1-1.ec2.redns.redis-cloud.com', error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Error handling for invalid JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.error('Invalid JSON payload', { method: req.method, url: req.url, body: req.body, error: err.message });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

// MongoDB connection
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

// Register routes
const routes = [
  { path: '/auth', handler: authRoutes, name: 'authRoutes' },
  { path: '/jobseeker', handler: jobseekerRoutes, name: 'jobseekerRoutes' },
  { path: '/employer', handler: employerRoutes, name: 'employerRoutes' },
  { path: '/social', handler: socialRoutes(io), name: 'socialRoutes' },
];

logger.info('Inspecting route handlers:', {
  authRoutes: authRoutes ? 'defined' : 'undefined',
  jobseekerRoutes: jobseekerRoutes ? 'defined' : 'undefined',
  employerRoutes: employerRoutes ? 'defined' : 'undefined',
  socialRoutes: socialRoutes ? 'defined' : 'undefined',
  socialRoutesResult: socialRoutes(io) ? 'defined' : 'undefined',
});

routes.forEach(({ path, handler, name }) => {
  if (handler && (typeof handler === 'function' || (typeof handler === 'object' && handler.handle))) {
    logger.info(`Registering route: ${path}`);
    app.use(path, handler);
  } else {
    logger.error(`Skipping invalid route handler for ${path} (${name})`, {
      handlerType: typeof handler,
      handler: handler,
    });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  const indexPath = path.join(buildPath, 'index.html');
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

// Socket.IO connection
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

// Shutdown handler
const shutdown = async () => {
  logger.info('Shutting down server');
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
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