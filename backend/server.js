require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const redis = require('./redis');
const winston = require('winston');
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
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
  ],
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000', // Tighten for production
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 120000, // Increased for stability
  pingInterval: 30000, // Matches client keep-alive
  transports: ['websocket', 'polling'], // Explicit transport options
});
app.set('io', io);

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

const buildPath = path.join(__dirname, '../frontend/build');
logger.info(`Serving static files from: ${buildPath}`);
app.use(express.static(buildPath));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime(), mongodb: mongoose.connection.readyState });
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
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error('MongoDB connection error:', { error: err.message });
    process.exit(1);
  }
};
connectDB();

// Routes
app.use('/auth', authRoutes);
app.use('/jobseeker', authMiddleware, jobseekerRoutes); // Protect routes
app.use('/employer', authMiddleware, employerRoutes);
app.use('/social', socialRoutes(io));

// Fallback for client-side routing (only serve index.html if not authenticated)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path === '/health') return next();
  
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (token) {
    // If authenticated, let client-side routing handle it (do not serve index.html)
    return res.status(404).json({ error: 'Not Found - Use client-side routing' });
  }

  const indexPath = path.join(buildPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      logger.error('Failed to serve index.html', { path: indexPath, error: err.message });
      res.status(500).send('Server Error - Static files may not be built correctly');
    }
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { method: req.method, url: req.url, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Socket.IO Setup
io.on('connection', (socket) => {
  logger.info('User connected', { socketId: socket.id });

  socket.on('join', (userId) => {
    socket.join(userId);
    logger.info('User joined room', { userId, socketId: socket.id });
  });

  socket.on('ping', ({ userId }) => {
    logger.debug('Ping received', { userId, socketId: socket.id });
    socket.emit('pong', { userId }); // Optional response
  });

  socket.on('disconnect', (reason) => {
    logger.info('User disconnected', { socketId: socket.id, reason });
  });

  socket.on('connect_error', (error) => {
    logger.error('Socket connection error', { socketId: socket.id, error: error.message });
  });

  socket.on('reconnect_attempt', (attempt) => {
    logger.info('Reconnection attempt', { socketId: socket.id, attempt });
  });

  socket.on('reconnect_failed', () => {
    logger.error('Reconnection failed', { socketId: socket.id });
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => logger.info(`Server running on port ${PORT}`));

const shutdown = async () => {
  logger.info('Shutting down server');
  await redis.quit();
  await mongoose.connection.close();
  io.close(() => logger.info('Socket.IO closed'));
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);