require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const winston = require('winston');
const fs = require('fs');
const Message = require('./models/Message');
const TokenBlacklist = require('./models/TokenBlacklist');
const { authMiddleware } = require('./routes/auth'); // Changed: Import authMiddleware explicitly

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }), // Changed: Add error log
  ],
});

let authRoutes, socialRoutes, feedRoutes, jobseekerRoutes, employerRoutes;
try {
  ({ router: authRoutes } = require('./routes/auth'));
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
  maxHttpBufferSize: 1e6, // Changed: Limit payload size to 1MB
});
app.set('io', io);

app.use(cors({
  origin: ['https://gapp-6yc3.onrender.com', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' })); // Changed: Reduce JSON limit to 10MB
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Changed: Add URL-encoded parsing

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
  logger.error(`Failed to access build directory: ${buildPath}`, { error: err.message });
}

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    uptime: process.uptime(), 
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' // Changed: Add DB status
  });
});

// Changed: JSON parsing error middleware
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.error('Invalid JSON payload', { method: req.method, url: req.url, body: req.body, error: err.message });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

// Changed: Retry MongoDB connection
const connectDB = async (retries = 5, baseDelay = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000, // Changed: Add timeout
        maxPoolSize: 10, // Changed: Limit connection pool
      });
      logger.info('MongoDB connected');
      // Changed: Run cleanup only once on startup
      const result = await Message.cleanupOrphanedMessages();
      logger.info('Initial orphaned messages cleanup completed', {
        deletedCount: result.deletedCount,
        orphanedUserIds: result.orphanedUserIds,
      });
      return;
    } catch (err) {
      logger.error(`MongoDB connection attempt ${attempt} failed`, { error: err.message });
      if (attempt === retries) {
        logger.error('MongoDB connection failed after max retries', { error: err.message, stack: err.stack });
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * baseDelay));
    }
  }
};

// Changed: Periodic cleanup with configurable interval
const startPeriodicCleanup = () => {
  const interval = 6 * 60 * 60 * 1000; // 6 hours
  setInterval(async () => {
    try {
      const result = await Message.cleanupOrphanedMessages();
      logger.info('Periodic orphaned messages cleanup completed', {
        deletedCount: result.deletedCount,
        orphanedUserIds: result.orphanedUserIds,
      });
    } catch (err) {
      logger.error('Periodic orphaned messages cleanup failed', { error: err.message });
    }
  }, interval);
};

// Changed: Initialize DB and cleanup
const initializeDB = async () => {
  await connectDB();
  startPeriodicCleanup();
};
initializeDB();

const routes = [
  { path: '/auth', handler: authRoutes, name: 'authRoutes' },
  { path: '/feed', handler: feedRoutes, name: 'feedRoutes' },
  { path: '/social', handler: socialRoutes(app), name: 'socialRoutes' },
  { path: '/jobseeker', handler: jobseekerRoutes, name: 'jobseekerRoutes' },
  { path: '/employer', handler: employerRoutes, name: 'employerRoutes' },
];

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

// Changed: Optimize static file serving
app.get('*', (req, res) => {
  const indexPath = path.join(buildPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath, { maxAge: 3600000 }, (err) => { // Changed: Cache for 1 hour
      if (err) {
        logger.error('Failed to serve index.html', { path: indexPath, error: err.message });
        res.status(500).json({ error: 'Server Error - Static files may not be available' });
      }
    });
  } else {
    logger.error('index.html not found', { path: indexPath });
    res.status(500).json({ error: 'Server Error - Frontend not built' });
  }
});

// Changed: Global error handler with detailed logging
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.url,
    ip: req.ip,
  });
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// Changed: Socket.IO with authentication and retry
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    logger.warn('No token provided for socket connection', { socketId: socket.id });
    return next(new Error('No token provided'));
  }

  try {
    // Changed: Use authMiddleware logic
    const blacklisted = await TokenBlacklist.findOne({ token }).lean();
    if (blacklisted) {
      logger.warn('Blacklisted token used for socket', { socketId: socket.id });
      return next(new Error('Token is blacklisted'));
    }

    const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded.id || !mongoose.isValidObjectId(decoded.id)) {
      logger.warn('Invalid user ID in socket token', { socketId: socket.id });
      return next(new Error('Invalid token'));
    }

    socket.userId = decoded.id;
    next();
  } catch (error) {
    logger.error('Socket auth error', { error: error.message, socketId: socket.id });
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  logger.info('User connected', { socketId: socket.id, userId: socket.userId });

  socket.on('join', (userId) => {
    if (userId !== socket.userId) {
      logger.warn('Unauthorized join attempt', { socketId: socket.id, userId, authUserId: socket.userId });
      return;
    }
    socket.join(userId);
    logger.info('User joined room', { userId, socketId: socket.id });
  });

  socket.on('message', async (msg, callback) => {
    try {
      if (!msg.recipientId || !msg.senderId || !mongoose.isValidObjectId(msg.recipientId) || !mongoose.isValidObjectId(msg.senderId)) {
        logger.warn('Invalid message data', { socketId: socket.id, msg });
        return callback({ error: 'Invalid message data' });
      }
      if (msg.senderId !== socket.userId) {
        logger.warn('Unauthorized message attempt', { socketId: socket.id, senderId: msg.senderId, authUserId: socket.userId });
        return callback({ error: 'Unauthorized' });
      }

      // Changed: Save message with retry
      const retrySave = async (retries = 3, baseDelay = 1000) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const message = new Message({
              senderId: msg.senderId,
              recipientId: msg.recipientId,
              content: msg.content,
              clientMessageId: msg.clientMessageId,
              timestamp: new Date(),
            });
            await message.save();
            return message;
          } catch (err) {
            if (attempt === retries) throw err;
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * baseDelay));
          }
        }
      };

      const savedMessage = await retrySave();
      io.to(msg.recipientId).emit('message', savedMessage);
      callback({ status: 'ok', message: savedMessage });
    } catch (err) {
      logger.error('Socket message error', { error: err.message, socketId: socket.id, msg });
      callback({ error: err.message });
    }
  });

  socket.on('readMessages', async ({ chatId, userId }) => {
    if (!mongoose.isValidObjectId(chatId) || userId !== socket.userId) {
      logger.warn('Invalid readMessages data', { socketId: socket.id, chatId, userId });
      return;
    }
    try {
      // Changed: Update message status with retry
      const retryUpdate = async (retries = 3, baseDelay = 1000) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            await Message.updateMany(
              { recipientId: userId, senderId: chatId, read: false },
              { $set: { read: true, readAt: new Date() } }
            );
            return;
          } catch (err) {
            if (attempt === retries) throw err;
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * baseDelay));
          }
        }
      };
      await retryUpdate();
      io.to(chatId).emit('readMessages', { chatId, userId });
    } catch (err) {
      logger.error('Socket readMessages error', { error: err.message, socketId: socket.id });
    }
  });

  socket.on('typing', ({ chatId, userId }) => {
    if (!mongoose.isValidObjectId(chatId) || userId !== socket.userId) {
      logger.warn('Invalid typing data', { socketId: socket.id, chatId, userId });
      return;
    }
    socket.to(chatId).emit('typing', { chatId, userId });
  });

  socket.on('leave', (userId) => {
    if (userId !== socket.userId) {
      logger.warn('Unauthorized leave attempt', { socketId: socket.id, userId, authUserId: socket.userId });
      return;
    }
    socket.leave(userId);
    logger.info('User left room', { userId, socketId: socket.id });
  });

  socket.on('disconnect', () => {
    logger.info('User disconnected', { socketId: socket.id, userId: socket.userId });
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => logger.info(`Server running on port ${PORT}`));

// Changed: Graceful shutdown with timeout
const shutdown = async () => {
  logger.info('Shutting down server');
  try {
    await Promise.race([
      mongoose.connection.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MongoDB close timeout')), 5000)),
    ]);
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
  // Changed: Force exit if shutdown takes too long
  setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);