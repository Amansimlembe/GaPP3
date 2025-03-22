require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
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

// Make io globally available for routes
global.io = io;

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

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB Atlas connected');
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

  socket.on('join', (userId) => {
    socket.join(userId);
    console.log(`${userId} joined`);
  });

  socket.on('message', (data) => {
    io.to(data.recipientId).emit('message', data);
    io.to(data.senderId).emit('message', data);
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

  socket.on('messageStatus', ({ messageId, status }) => {
    io.emit('messageStatus', { messageId, status });
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// Fallback for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));