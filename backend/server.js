require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
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
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 120000,
  pingInterval: 30000,
  transports: ['websocket', 'polling'],
});
app.set('io', io);

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime(), mongodb: mongoose.connection.readyState });
});

app.use((req, res, next) => {
  logger.info('Incoming request', { method: req.method, url: req.url, ip: req.ip });
  next();
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.error('Invalid JSON payload', { method: req.method, url: req.url, body: req.body, error: err.message });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not defined');
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

app.use('/auth', authRoutes);
app.use('/jobseeker', authMiddleware, jobseekerRoutes);
app.use('/employer', authMiddleware, employerRoutes);
app.use('/social', socialRoutes);

// Handle 404s
app.use((req, res) => {
  logger.warn('Route not found', { method: req.method, url: req.url });
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { method: req.method, url: req.url, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

io.on('connection', (socket) => {
  logger.info('User connected', { socketId: socket.id });

  socket.on('join', (userId) => {
    if (!userId) return logger.warn('Join attempted without userId', { socketId: socket.id });
    socket.join(userId);
    logger.info('User joined room', { userId, socketId: socket.id });
    io.to(userId).emit('onlineStatus', { userId, status: 'online', lastSeen: null });
  });

  socket.on('ping', ({ userId }) => {
    logger.debug('Ping received', { userId, socketId: socket.id });
    socket.emit('pong', { userId });
  });

  socket.on('message', (msg) => {
    logger.info('Message received', { msg, socketId: socket.id });
    io.to(msg.recipientId).emit('message', msg);
    io.to(msg.senderId).emit('message', msg);
  });

  socket.on('typing', ({ userId, recipientId }) => {
    io.to(recipientId).emit('typing', { userId });
  });

  socket.on('stopTyping', ({ userId, recipientId }) => {
    io.to(recipientId).emit('stopTyping', { userId });
  });

  socket.on('messageStatus', ({ messageId, status, recipientId }) => {
    io.to(recipientId).emit('messageStatus', { messageId, status });
  });

  socket.on('newContact', ({ userId, contactData }) => {
    logger.info('New contact added', { userId, contactId: contactData.id });
    io.to(userId).emit('newContact', contactData);
  });

  socket.on('leave', (userId) => {
    socket.leave(userId);
    logger.info('User left room', { userId, socketId: socket.id });
    io.to(userId).emit('onlineStatus', { userId, status: 'offline', lastSeen: new Date().toISOString() });
  });

  socket.on('disconnect', (reason) => {
    logger.info('User disconnected', { socketId: socket.id, reason });
  });

  socket.on('connect_error', (error) => {
    logger.error('Socket connection error', { socketId: socket.id, error: error.message });
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