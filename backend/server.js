require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
const redis = require('redis');
const authRoutes = require('./routes/auth');
const jobseekerRoutes = require('./routes/jobseeker');
const employerRoutes = require('./routes/employer');
const socialRoutes = require('./routes/social');
const Message = require('./models/Message');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

global.io = io;

// Redis client setup
const redisClient = redis.createClient({
  url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
  password: process.env.REDIS_PASSWORD,
});

redisClient.on('connect', () => console.log('Connected to Redis'));
redisClient.on('error', (err) => console.error('Redis error:', err));
redisClient.connect();

// Cloudinary configuration
cloudinary.config({
  cloud_name: 'dsygdul20',
  api_key: '442966176347917',
  api_secret: '78quUIGGD4YkjmLe87FJG21EOfk',
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../frontend/build')));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`Incoming request: ${req.method} ${req.url}`);
  next();
});

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Atlas connected');

    await Message.collection.createIndex({ senderId: 1, recipientId: 1, createdAt: -1 });
    console.log('Messages index created');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};
connectDB();

// Routes
app.use('/auth', authRoutes);
app.use('/jobseeker', jobseekerRoutes);
app.use('/employer', employerRoutes);
app.use('/social', socialRoutes);

// Socket.IO events
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', async (userId) => {
    socket.join(userId);
    console.log(`${userId} joined`);
    // Mark user as online in Redis
    await redisClient.set(`online:${userId}`, 'true', { EX: 3600 }); // Expire after 1 hour
  });

  socket.on('message', async (data) => {
    const isRecipientOnline = await redisClient.get(`online:${data.recipientId}`);
    const status = isRecipientOnline ? 'delivered' : 'sent';
    const message = await Message.findById(data._id);
    if (message) {
      message.status = status;
      await message.save();
      io.to(data.recipientId).emit('message', { ...data, status });
      io.to(data.senderId).emit('message', { ...data, status });
    }
  });

  socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
    const message = await Message.findById(messageId);
    if (message) {
      message.status = status;
      await message.save();
      io.to(recipientId).emit('messageStatus', { messageId, status });
      io.to(message.senderId).emit('messageStatus', { messageId, status });
    }
  });

  socket.on('typing', ({ userId, recipientId }) => {
    io.to(recipientId).emit('typing', { userId, recipientId });
  });

  socket.on('stopTyping', ({ userId, recipientId }) => {
    io.to(recipientId).emit('stopTyping', { userId, recipientId });
  });

  socket.on('newPost', (post) => {
    io.emit('newPost', post);
  });

  socket.on('postUpdate', (post) => {
    io.emit('postUpdate', post);
  });

  socket.on('postDeleted', (postId) => {
    io.emit('postDeleted', postId);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    const rooms = Array.from(socket.rooms);
    const userId = rooms.find((room) => room !== socket.id);
    if (userId) {
      await redisClient.del(`online:${userId}`);
    }
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// SPA fallback with logging
app.get('*', (req, res) => {
  console.log('Serving frontend index.html');
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// Server error logging
server.on('error', (error) => {
  console.error('Server startup error:', error);
});