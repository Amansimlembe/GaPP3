require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const winston = require('winston');
const fs = require('fs');
const jwt = require('jsonwebtoken'); // Added for Socket.IO auth
const Message = require('./models/Message');
const TokenBlacklist = require('./models/TokenBlacklist'); // Import TokenBlacklist model

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }), // Added error-specific log
  ],
});

// Validate critical environment variables
const requiredEnvVars = ['MONGO_URI', 'JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingEnvVars.length > 0) {
  logger.error('Missing required environment variables', { missing: missingEnvVars });
  process.exit(1);
}

let authRoutes, authMiddleware, socialRoutes, feedRoutes, jobseekerRoutes, employerRoutes;
try {
  ({ router: authRoutes, authMiddleware } = require('./routes/auth'));
  socialRoutes = require('./routes/social');
  feedRoutes = require('./routes/feed');
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
  transports: ['websocket', 'polling'], // Explicitly allow both transports
});
app.set('io', io);

app.use(cors({
  origin: ['https://gapp-6yc3.onrender.com', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Added for form data

const buildPath = path.join(__dirname, '..', 'frontend', 'build');
logger.info(`Attempting to serve static files from: ${buildPath}`);
try {
  if (fs.existsSync(buildPath)) {
    const buildFiles = fs.readdirSync(buildPath);
    logger.info(`Build directory contents: ${buildFiles.join(', ')}`);
    app.use(express.static(buildPath));
  } else {
    logger.warn(`Build directory not found: ${buildPath}. Static files will not be served.`);
  }
} catch (err) {
  logger.error(`Failed to access build directory: ${buildPath}`, { error: err.message, stack: err.stack });
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime(), mongodb: mongoose.connection.readyState });
});

// Middleware for JSON parsing errors
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
      serverSelectionTimeoutMS: 5000, // Timeout for initial connection
      maxPoolSize: 10, // Limit connection pool size
    });
    logger.info('MongoDB connected');
    try {
      const result = await Message.cleanupOrphanedMessages();
      logger.info('Initial orphaned messages cleanup completed', {
        deletedCount: result.deletedCount,
        orphanedUserIds: result.orphanedUserIds,
      });
    } catch (err) {
      logger.error('Initial orphaned messages cleanup failed', { error: err.message, stack: err.stack });
    }
    setInterval(async () => {
      try {
        const result = await Message.cleanupOrphanedMessages();
        logger.info('Periodic orphaned messages cleanup completed', {
          deletedCount: result.deletedCount,
          orphanedUserIds: result.orphanedUserIds,
        });
      } catch (err) {
        logger.error('Periodic orphaned messages cleanup failed', { error: err.message, stack: err.stack });
      }
    }, 6 * 60 * 60 * 1000); // Every 6 hours
  } catch (err) {
    logger.error('MongoDB connection error:', { error: err.message, stack: err.stack });
    process.exit(1);
  }
};
connectDB();

const routes = [
  { path: '/auth', handler: authRoutes, name: 'authRoutes' },
  { path: '/feed', handler: feedRoutes, name: 'feedRoutes' },
  { path: '/social', handler: socialRoutes(app), name: 'socialRoutes' },
  { path: '/jobseeker', handler: jobseekerRoutes, name: 'jobseekerRoutes' },
  { path: '/employer', handler: employerRoutes, name: 'employerRoutes' },
];

routes.forEach(({ path, handler, name }) => {
  try {
    if (handler && (typeof handler === 'function' || (typeof handler === 'object' && handler.handle))) {
      logger.info(`Registering route: ${path}`);
      app.use(path, handler);
    } else {
      logger.error(`Skipping invalid route handler for ${path} (${name})`, {
        handlerType: typeof handler,
        handler: handler,
      });
    }
  } catch (err) {
    logger.error(`Failed to register route: ${path}`, { error: err.message, stack: err.stack });
  }
});

app.get('*', (req, res) => {
  const indexPath = path.join(buildPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath, (err) => {
      if (err) {
        logger.error('Failed to serve index.html', { path: indexPath, error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Server Error - Static files may not be available' });
      }
    });
  } else {
    logger.error('index.html not found', { path: indexPath });
    res.status(404).json({ error: 'Frontend not built or unavailable' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, method: req.method, url: req.url });
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    logger.warn('No token provided for Socket.IO connection', { socketId: socket.id });
    return next(new Error('No token provided'));
  }

  try {
    // Check if token is blacklisted
    const blacklisted = await TokenBlacklist.findOne({ token });
    if (blacklisted) {
      logger.warn('Blacklisted token used for Socket.IO', { token: token.substring(0, 10) + '...', socketId: socket.id });
      return next(new Error('Token is blacklisted'));
    }

    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!mongoose.isValidObjectId(decoded.id)) {
      logger.warn('Invalid user ID in Socket.IO token', { userId: decoded.id, socketId: socket.id });
      return next(new Error('Invalid token'));
    }

    socket.user = decoded;
    logger.info('Socket.IO authentication successful', { userId: decoded.id, socketId: socket.id });
    next();
  } catch (error) {
    logger.error('Socket.IO auth error:', {
      error: error.message,
      token: token.substring(0, 10) + '...',
      socketId: socket.id,
    });
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  logger.info('User connected', { socketId: socket.id, userId: socket.user.id });

  socket.on('join', (userId) => {
    try {
      if (userId !== socket.user.id) {
        logger.warn('Unauthorized join attempt', { userId, socketUserId: socket.user.id, socketId: socket.id });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }
      socket.join(userId);
      logger.info('User joined room', { userId, socketId: socket.id });
    } catch (err) {
      logger.error('Join event error', { error: err.message, userId, socketId: socket.id });
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  socket.on('message', async (msg, callback) => {
    try {
      if (!msg.recipientId || !mongoose.isValidObjectId(msg.recipientId)) {
        throw new Error('Invalid recipient ID');
      }
      if (msg.senderId !== socket.user.id) {
        throw new Error('Unauthorized message sender');
      }
      io.to(msg.recipientId).emit('message', msg);
      callback({ status: 'ok', message: msg });
      logger.info('Message sent', { senderId: msg.senderId, recipientId: msg.recipientId, socketId: socket.id });
    } catch (err) {
      logger.error('Socket message error', { error: err.message, socketId: socket.id });
      callback({ error: err.message });
    }
  });

  socket.on('readMessages', ({ chatId, userId }) => {
    try {
      if (userId !== socket.user.id || !mongoose.isValidObjectId(chatId)) {
        throw new Error('Unauthorized or invalid chat ID');
      }
      io.to(chatId).emit('readMessages', { chatId, userId });
      logger.info('Read messages event', { chatId, userId, socketId: socket.id });
    } catch (err) {
      logger.error('Read messages event error', { error: err.message, chatId, userId, socketId: socket.id });
      socket.emit('error', { message: 'Failed to process read messages' });
    }
  });

  socket.on('typing', ({ chatId, userId }) => {
    try {
      if (userId !== socket.user.id || !mongoose.isValidObjectId(chatId)) {
        throw new Error('Unauthorized or invalid chat ID');
      }
      socket.to(chatId).emit('typing', { chatId, userId });
      logger.info('Typing event', { chatId, userId, socketId: socket.id });
    } catch (err) {
      logger.error('Typing event error', { error: err.message, chatId, userId, socketId: socket.id });
      socket.emit('error', { message: 'Failed to process typing event' });
    }
  });

  socket.on('leave', (userId) => {
    try {
      if (userId !== socket.user.id) {
        logger.warn('Unauthorized leave attempt', { userId, socketUserId: socket.user.id, socketId: socket.id });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }
      socket.leave(userId);
      logger.info('User left room', { userId, socketId: socket.id });
    } catch (err) {
      logger.error('Leave event error', { error: err.message, userId, socketId: socket.id });
      socket.emit('error', { message: 'Failed to leave room' });
    }
  });

  socket.on('disconnect', () => {
    logger.info('User disconnected', { socketId: socket.id, userId: socket.user.id });
  });

  socket.on('error', (err) => {
    logger.error('Socket error', { error: err.message, socketId: socket.id, userId: socket.user.id });
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server running on port ${PORT}`);
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down server');
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (err) {
    logger.error('Error closing MongoDB connection during shutdown', { error: err.message, stack: err.stack });
  }
  io.close(() => {
    logger.info('Socket.IO connections closed');
  });
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  // Force exit after 10 seconds if shutdown hangs
  setTimeout(() => {
    logger.error('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 10000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  shutdown();
});
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled promise rejection', { error: err.message, stack: err.stack });
  shutdown();
});