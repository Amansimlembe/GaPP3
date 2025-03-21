require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const jobseekerRoutes = require('./routes/jobseeker');
const employerRoutes = require('./routes/employer');
const socialRoutes = require('./routes/social');
const Message = require('./models/Message');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Configure Cloudinary
cloudinary.config({
  cloud_name: 'dsygdul20',
  api_key: '442966176347917',
  api_secret: '78quUIGGD4YkjmLe87FJG21EOfk',
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase payload limit for uploads

// Serve React build files
app.use(express.static(path.join(__dirname, '../frontend/build')));

// MongoDB connection
connectDB().catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});

// API Routes
app.use('/auth', authRoutes);
app.use('/jobseeker', jobseekerRoutes);
app.use('/employer', employerRoutes);
app.use('/social', socialRoutes);

// Socket.IO for real-time chat
io.on('connection', (socket) => {
  socket.on('join', (userId) => socket.join(userId));
  socket.on('message', async (data) => {
    try {
      const message = new Message(data);
      await message.save();
      io.to(data.recipientId).emit('message', message);
      socket.emit('message', message);
    } catch (error) {
      console.error('Socket.IO message error:', error);
    }
  });
  socket.on('webrtc_signal', (data) => io.to(data.to).emit('webrtc_signal', data));
  socket.on('error', (err) => console.error('Socket.IO error:', err));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Catch-all route for React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));