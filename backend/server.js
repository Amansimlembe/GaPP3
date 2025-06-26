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
const { authMiddleware } = require('./routes/auth');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
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
  logger.error('Failed to load routes', { error: err.message });
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
  maxHttpBufferSize: 1e6,
  transports: ['websocket'],
  allowEIO3: false,
  connectionStateRecovery: {
    maxDisconnectionDuration: 5 * 60 * 1000, // 5 minutes
    skipMiddlewares: true,
  },
});
app.set('io', io);




app.use(cors({
  origin: ['https://gapp-6yc3.onrender.com', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const buildPath = path.join(__dirname, '..', 'frontend', 'build');
try {
  if (fs.existsSync(buildPath)) {
    const buildFiles = fs.readdirSync(buildPath);
    logger.info(`Serving static files from: ${buildPath}`, { files: buildFiles });
    app.use(express.static(buildPath, { maxAge: '1h' }));
  } else {
    logger.warn(`Build directory not found: ${buildPath}. Static files will not be served.`);
  }
} catch (err) {
  logger.error(`Failed to access build directory: ${buildPath}`, { error: err.message });
}

app.get('/health', async (req, res) => {
  try {
    const authResponse = await fetch(`${process.env.BASE_URL || 'https://gapp-6yc3.onrender.com'}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    res.status(200).json({
      status: 'OK',
      uptime: process.uptime(),
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      authEndpoint: authResponse.status,
    });
  } catch (err) {
    logger.error('Health check failed', { error: err.message });
    res.status(200).json({
      status: 'OK',
      uptime: process.uptime(),
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      authEndpoint: 'unreachable',
    });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.error('Invalid JSON payload', { method: req.method, url: req.url, body: req.body, error: err.message });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

const retryOperation = async (operation, maxRetries = 3, baseDelay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      logger.warn(`Operation failed, attempt ${attempt}/${maxRetries}`, { error: err.message });
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt) * baseDelay * (1 + Math.random() * 0.1); // Add jitter
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

const connectDB = async (retries = 5, baseDelay = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 10,
        socketTimeoutMS: 45000, // Added for better connection stability
      });
      logger.info('MongoDB connected');
      return;
    } catch (err) {
      logger.warn(`MongoDB connection attempt ${attempt}/${retries} failed`, { error: err.message });
      if (attempt === retries) {
        logger.error('MongoDB connection failed after max retries', { error: err.message });
        process.exit(1);
      }
      const delay = Math.pow(2, attempt) * baseDelay * (1 + Math.random() * 0.1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

const startPeriodicCleanup = () => {
  const interval = 6 * 60 * 60 * 1000; // 6 hours
  setInterval(async () => {
    try {
      const result = await retryOperation(() => Message.cleanupOrphanedMessages());
      logger.info('Periodic orphaned messages cleanup completed', {
        deletedCount: result.deletedCount,
        orphanedUserIds: result.orphanedUserIds,
      });
    } catch (err) {
      logger.error('Periodic orphaned messages cleanup failed', { error: err.message });
    }
  }, interval);
};

const initializeDB = async () => {
  await connectDB();
  try {
    const result = await retryOperation(() => Message.cleanupOrphanedMessages());
    logger.info('Initial orphaned messages cleanup completed', {
      deletedCount: result.deletedCount,
      orphanedUserIds: result.orphanedUserIds,
    });
  } catch (err) {
    logger.error('Initial orphaned messages cleanup failed', { error: err.message });
  }
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
    app.use(path, handler);
  } else {
    logger.warn(`Invalid route handler for ${name}`, { path });
  }
});

app.get('*', (req, res) => {
  const indexPath = path.join(buildPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath, { maxAge: 3600000 }, (err) => {
      if (err) {
        logger.error('Failed to serve index.html', { error: err.message });
        res.status(500).json({ error: 'Server Error - Static files may not be available' });
      }
    });
  } else {
    logger.warn('index.html not found', { path: indexPath });
    res.status(500).json({ error: 'Server Error - Frontend not built' });
  }
});

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

io.use(async (socket, next) => {
  const req = {
    headers: { authorization: `Bearer ${socket.handshake.auth.token}` },
    user: null,
    token: socket.handshake.auth.token,
  };
  const res = {
    status: (code) => ({
      json: (data) => {
        logger.warn('Socket authentication failed', { socketId: socket.id, error: data.error || 'Authentication error' });
        next(new Error(data.error || 'Authentication error'));
      },
    }),
  };

  try {
    await authMiddleware(req, res, () => {
      socket.user = req.user;
      logger.info('Socket authenticated', { socketId: socket.id, userId: req.user.id });
      next();
    });
  } catch (err) {
    logger.error('Socket authentication error', { socketId: socket.id, error: err.message });
    next(new Error('Authentication error'));
  }
});






io.on('connection', (socket) => {
  logger.info('User connected', { socketId: socket.id, userId: socket.user.id });

  // Store connected users
  const connectedUsers = new Map();
  connectedUsers.set(socket.user.id, socket.id);

  socket.on('join', (data) => {
    const userId = typeof data === 'object' ? data.userId : data;
    if (!userId || userId !== socket.user.id) {
      logger.warn('Invalid join attempt', { socketId: socket.id, userId, expectedUserId: socket.user.id });
      socket.emit('error', { message: 'Invalid user ID' });
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
      if (msg.senderId !== socket.user.id) {
        logger.warn('Unauthorized message send attempt', { socketId: socket.id, senderId: msg.senderId, userId: socket.user.id });
        return callback({ error: 'Unauthorized' });
      }

      // Check for duplicate message
      const existingMessage = await Message.findOne({ clientMessageId: msg.clientMessageId });
      if (existingMessage) {
        logger.warn('Duplicate message detected', { socketId: socket.id, clientMessageId: msg.clientMessageId });
        return callback({ status: 'ok', message: existingMessage });
      }

      const savedMessage = await retryOperation(async () => {
        const message = new Message({
          senderId: msg.senderId,
          recipientId: msg.recipientId,
          content: msg.content,
          contentType: msg.contentType || 'text',
          clientMessageId: msg.clientMessageId,
          senderVirtualNumber: msg.senderVirtualNumber,
          senderUsername: msg.senderUsername,
          senderPhoto: msg.senderPhoto,
          timestamp: new Date(),
          status: 'sent',
        });
        return await message.save();
      });

      io.to(msg.recipientId).emit('message', savedMessage);
      callback({ status: 'ok', message: savedMessage });
    } catch (err) {
      logger.error('Message save failed', { socketId: socket.id, error: err.message, msg });
      callback({ error: 'Failed to save message', details: err.message });
    }
  });

  socket.on('batchMessageStatus', async ({ messageIds, status, recipientId }) => {
    if (!Array.isArray(messageIds) || !messageIds.every(mongoose.isValidObjectId) || !['sent', 'delivered', 'read'].includes(status) || recipientId !== socket.user.id) {
      logger.warn('Invalid batchMessageStatus data', { socketId: socket.id, messageIds, status, recipientId });
      socket.emit('error', { message: 'Invalid batch message status data' });
      return;
    }
    try {
      await retryOperation(async () => {
        await Message.updateMany(
          { _id: { $in: messageIds }, recipientId },
          { $set: { status, readAt: status === 'read' ? new Date() : undefined } }
        );
      });
      io.to(recipientId).emit('messageStatus', { messageIds, status });
    } catch (err) {
      logger.error('Batch message status update failed', { socketId: socket.id, error: err.message });
      socket.emit('error', { message: 'Failed to update message status' });
    }
  });

  socket.on('typing', ({ chatId, userId }) => {
    if (!mongoose.isValidObjectId(chatId) || userId !== socket.user.id) {
      logger.warn('Invalid typing event', { socketId: socket.id, chatId, userId });
      return;
    }
    socket.to(chatId).emit('typing', { chatId, userId });
  });

  socket.on('stopTyping', ({ chatId, userId }) => {
    if (!mongoose.isValidObjectId(chatId) || userId !== socket.user.id) {
      logger.warn('Invalid stopTyping event', { socketId: socket.id, chatId, userId });
      return;
    }
    socket.to(chatId).emit('stopTyping', { chatId, userId });
  });

  socket.on('leave', (userId) => {
    if (!userId || userId !== socket.user.id) {
      logger.warn('Invalid leave attempt', { socketId: socket.id, userId, expectedUserId: socket.user.id });
      socket.emit('error', { message: 'Invalid user ID' });
      return;
    }
    socket.leave(userId);
    logger.info('User left room', { userId, socketId: socket.id });
  });

  socket.on('disconnect', (reason) => {
    logger.info('User disconnected', { socketId: socket.id, userId: socket.user.id, reason });
    connectedUsers.delete(socket.user.id);
  });

  socket.on('error', (err) => {
    logger.error('Socket error', { socketId: socket.id, userId: socket.user.id, error: err.message });
  });
});









const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => logger.info(`Server running on port ${PORT}`));

const shutdown = async () => {
  logger.info('Shutting down server');
  try {
    await Promise.race([
      mongoose.connection.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MongoDB close timeout')), 5000)),
    ]);
    logger.info('MongoDB connection closed');
  } catch (err) {
    logger.error('Failed to close MongoDB connection', { error: err.message });
  }
  io.close(() => {
    logger.info('Socket.IO connections closed');
  });
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Server shutdown timed out');
    process.exit(1);
  }, 10000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);