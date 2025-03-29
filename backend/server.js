require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
const redis = require('redis');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const { router: authRoutes, authMiddleware } = require('./routes/auth');
const jobseekerRoutes = require('./routes/jobseeker');
const employerRoutes = require('./routes/employer');
const socialRoutes = require('./routes/social');
const Message = require('./models/Message');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

const onlineUsers = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.set('io', io);

const redisClient = redis.createClient({
  url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
  password: process.env.REDIS_PASSWORD,
});

redisClient.on('connect', () => logger.info('Connected to Redis'));
redisClient.on('error', (err) => logger.error('Redis error:', { error: err.message }));
redisClient.connect();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests, please try again later.' },
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../frontend/build')));
app.use(globalLimiter);
app.use((req, res, next) => {
  logger.info('Incoming request', { method: req.method, url: req.url, ip: req.ip });
  next();
});

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    logger.info('MongoDB Atlas connected');

    await Message.collection.createIndex({ senderId: 1, recipientId: 1, createdAt: -1 });
    logger.info('Messages index created');
  } catch (error) {
    logger.error('MongoDB connection error:', { error: error.message });
    process.exit(1);
  }
};
connectDB();

app.use('/auth', authRoutes);
app.use('/jobseeker', jobseekerRoutes);
app.use('/employer', employerRoutes);
app.use('/social', socialRoutes(io));

io.on('connection', (socket) => {
  logger.info('User connected', { socketId: socket.id });

  socket.on('join', async (userId) => {
    if (!userId) {
      logger.error('Join event received without userId');
      return;
    }

    socket.join(userId);
    logger.info('User joined', { userId });

    try {
      await redisClient.set(`online:${userId}`, 'true', { EX: 3600 });
      onlineUsers.set(userId, { lastSeen: new Date(), socketId: socket.id, status: 'online' });
      io.emit('onlineStatus', { userId, status: 'online', lastSeen: onlineUsers.get(userId).lastSeen });
    } catch (error) {
      logger.error('Error setting online status in Redis', { userId, error: error.message });
    }
  });

  socket.on('message', async (data) => {
    try {
      if (!data.recipientId || !data._id) {
        logger.error('Invalid message data', { data });
        return;
      }

      const isRecipientOnline = await redisClient.get(`online:${data.recipientId}`);
      const status = isRecipientOnline ? 'delivered' : 'sent';
      const message = await Message.findById(data._id);

      if (message) {
        message.status = status;
        await message.save();
        io.to(data.recipientId).emit('message', { ...data, status });
        io.to(data.senderId).emit('message', { ...data, status });
        logger.info('Message sent', { messageId: data._id, status });
      } else {
        logger.error('Message not found', { messageId: data._id });
      }
    } catch (error) {
      logger.error('Error handling message event', { error: error.message });
    }
  });

  socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
    try {
      if (!messageId || !status || !recipientId) {
        logger.error('Invalid messageStatus data', { messageId, status, recipientId });
        return;
      }

      const message = await Message.findById(messageId);
      if (message) {
        message.status = status;
        await message.save();
        io.to(recipientId).emit('messageStatus', { messageId, status });
        io.to(message.senderId).emit('messageStatus', { messageId, status });
        logger.info('Message status updated', { messageId, status });
      } else {
        logger.error('Message not found for status update', { messageId });
      }
    } catch (error) {
      logger.error('Error handling messageStatus event', { error: error.message });
    }
  });

  socket.on('typing', ({ userId, recipientId }) => {
    if (!userId || !recipientId) {
      logger.error('Invalid typing event data', { userId, recipientId });
      return;
    }
    io.to(recipientId).emit('typing', { userId, recipientId });
    logger.info('Typing event', { userId, recipientId });
  });

  socket.on('stopTyping', ({ userId, recipientId }) => {
    if (!userId || !recipientId) {
      logger.error('Invalid stopTyping event data', { userId, recipientId });
      return;
    }
    io.to(recipientId).emit('stopTyping', { userId, recipientId });
    logger.info('Stop typing event', { userId, recipientId });
  });

  socket.on('newContact', (contact) => {
    logger.info('New contact event received on server', { contact });
  });

  socket.on('ping', ({ userId }) => {
    logger.info('Received ping', { userId });
    if (onlineUsers.has(userId)) {
      onlineUsers.set(userId, { ...onlineUsers.get(userId), lastSeen: new Date() });
    }
  });

  socket.on('error', (error) => {
    logger.error('Socket error', { error: error.message });
  });

  socket.on('disconnect', async () => {
    logger.info('User disconnected', { socketId: socket.id });
    const rooms = Array.from(socket.rooms);
    const userId = rooms.find((room) => room !== socket.id);
    if (userId) {
      try {
        await redisClient.del(`online:${userId}`);
        const userStatus = onlineUsers.get(userId);
        if (userStatus) {
          onlineUsers.set(userId, { ...userStatus, lastSeen: new Date(), status: 'offline' });
          io.emit('onlineStatus', { userId, status: 'offline', lastSeen: userStatus.lastSeen });
        }
      } catch (error) {
        logger.error('Error removing online status from Redis', { userId, error: error.message });
      }
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

app.use((err, req, res, next) => {
  logger.error('Global error', { error: err.stack });
  res.status(500).json({ error: 'Internal Server Error', details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred' });
});

app.get('*', (req, res) => {
  logger.info('Serving frontend index.html');
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server running on port ${PORT}`);
});

server.on('error', (error) => {
  logger.error('Server startup error', { error: error.message });
});

const shutdown = async () => {
  logger.info('Shutting down server...');
  try {
    await redisClient.quit();
    logger.info('Redis connection closed');
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { io, onlineUsers };