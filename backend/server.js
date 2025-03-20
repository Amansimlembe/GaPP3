require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const jobseekerRoutes = require('./routes/jobseeker');
const employerRoutes = require('./routes/employer');
const socialRoutes = require('./routes/social');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Serve React build files
app.use(express.static(path.join(__dirname, '../frontend/build')));

connectDB();

// API Routes
app.use('/auth', authRoutes);
app.use('/jobseeker', jobseekerRoutes);
app.use('/employer', employerRoutes);
app.use('/social', socialRoutes);

// Catch-all route to serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

// Socket.io for real-time chat
io.on('connection', (socket) => {
  socket.on('join', (userId) => socket.join(userId));
  socket.on('message', async (data) => {
    const { Message } = require('./models/Message');
    const message = new Message(data);
    await message.save();
    io.to(data.recipientId).emit('message', message);
    socket.emit('message', message);
  });
  socket.on('webrtc_signal', (data) => io.to(data.to).emit('webrtc_signal', data));
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));