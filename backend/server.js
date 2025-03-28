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

// In-memory cache for online status
const onlineUsers = new Map(); // Map<userId, { lastSeen: Date, socketId: string, status: string }>

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Redis client setup
const redisClient = redis.createClient({
  url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
  password: process.env.REDIS_PASSWORD,
});

redisClient.on('connect', () => console.log('Connected to Redis'));
redisClient.on('error', (err) => console.error('Redis error:', err));
redisClient.connect();

// Cloudinary configuration
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dsygdul20',
    api_key: process.env.CLOUDINARY_API_KEY || '442966176347917',
    api_secret: process.env.CLOUDINARY_API_SECRET || '78quUIGGD4YkjmLe87FJG21EOfk',
  });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../frontend/build')));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Incoming request: ${req.method} ${req.url} from ${req.ip}`);
  next();
});

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB Atlas connected');

    // Create indexes for better query performance
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
app.use('/social', socialRoutes(io));

// Socket.IO events
io.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] User connected: ${socket.id}`);

  socket.on('join', async (userId) => {
    if (!userId) {
      console.error('Join event received without userId');
      return;
    }

    socket.join(userId);
    console.log(`[${new Date().toISOString()}] ${userId} joined`);

    // Mark user as online in Redis
    try {
      await redisClient.set(`online:${userId}`, 'true', { EX: 3600 }); // Expire after 1 hour
      onlineUsers.set(userId, { lastSeen: new Date(), socketId: socket.id, status: 'online' });
      io.emit('onlineStatus', { userId, status: 'online' });
    } catch (error) {
      console.error(`Error setting online status for ${userId} in Redis:`, error);
    }
  });

  socket.on('message', async (data) => {
    try {
      if (!data.recipientId || !data._id) {
        console.error('Invalid message data:', data);
        return;
      }

      const isRecipientOnline = await redisClient.get(`online:${data.recipientId}`);
      const status = isRecipientOnline ? 'delivered' : 'sent';
      const message = await Message.findById(data._id);

      if (message) {
        message.status = status;
        await message.save();
        // Emit to both sender and recipient
        io.to(data.recipientId).emit('message', { ...data, status });
        io.to(data.senderId).emit('message', { ...data, status });
      } else {
        console.error(`Message not found: ${data._id}`);
      }
    } catch (error) {
      console.error('Error handling message event:', error);
    }
  });

  socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
    try {
      if (!messageId || !status || !recipientId) {
        console.error('Invalid messageStatus data:', { messageId, status, recipientId });
        return;
      }

      const message = await Message.findById(messageId);
      if (message) {
        message.status = status;
        await message.save();
        // Emit to both sender and recipient
        io.to(recipientId).emit('messageStatus', { messageId, status });
        io.to(message.senderId).emit('messageStatus', { messageId, status });
      } else {
        console.error(`Message not found for status update: ${messageId}`);
      }
    } catch (error) {
      console.error('Error handling messageStatus event:', error);
    }
  });

  socket.on('typing', ({ userId, recipientId }) => {
    if (!userId || !recipientId) {
      console.error('Invalid typing event data:', { userId, recipientId });
      return;
    }
    io.to(recipientId).emit('typing', { userId, recipientId });
  });

  socket.on('stopTyping', ({ userId, recipientId }) => {
    if (!userId || !recipientId) {
      console.error('Invalid stopTyping event data:', { userId, recipientId });
      return;
    }
    io.to(recipientId).emit('stopTyping', { userId, recipientId });
  });

  socket.on('newPost', (post) => {
    if (!post) {
      console.error('Invalid newPost event data');
      return;
    }
    io.emit('newPost', post);
  });

  socket.on('postUpdate', (post) => {
    if (!post) {
      console.error('Invalid postUpdate event data');
      return;
    }
    io.emit('postUpdate', post);
  });

  socket.on('postDeleted', (postId) => {
    if (!postId) {
      console.error('Invalid postDeleted event data');
      return;
    }
    io.emit('postDeleted', postId);
  });

  socket.on('ping', ({ userId }) => {
    console.log(`[${new Date().toISOString()}] Received ping from user: ${userId}`);
    // Update last seen in onlineUsers
    if (onlineUsers.has(userId)) {
      onlineUsers.set(userId, { ...onlineUsers.get(userId), lastSeen: new Date() });
    }
  });

  socket.on('error', (error) => {
    console.error(`[${new Date().toISOString()}] Socket error:`, error);
  });

  socket.on('disconnect', async () => {
    console.log(`[${new Date().toISOString()}] User disconnected: ${socket.id}`);
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
        console.error(`Error removing online status for ${userId} from Redis:`, error);
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Global error:`, err.stack);
  res.status(500).json({ error: 'Internal Server Error', details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred' });
});

// SPA fallback with logging
app.get('*', (req, res) => {
  console.log(`[${new Date().toISOString()}] Serving frontend index.html`);
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
});

// Server error logging
server.on('error', (error) => {
  console.error(`[${new Date().toISOString()}] Server startup error:`, error);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down server...');
  try {
    await redisClient.quit();
    console.log('Redis connection closed');
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Export io and onlineUsers for use in other modules
module.exports = { io, onlineUsers };