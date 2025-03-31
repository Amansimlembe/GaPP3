require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const redis = require('./redis'); // Use redis.js
const winston = require('winston');
const { router: authRoutes, authMiddleware } = require('./routes/auth');
const socialRoutes = require('./routes/social');
const jobseekerRoutes = require('./routes/jobseeker');
const employerRoutes = require('./routes/employer');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});
app.set('io', io);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../frontend/build')));

const connectDB = async () => {
  try {
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
app.use('/jobseeker', jobseekerRoutes);
app.use('/employer', employerRoutes);
app.use('/social', socialRoutes(io));

io.on('connection', (socket) => {
  socket.on('join', (userId) => socket.join(userId));
  socket.on('disconnect', () => logger.info('User disconnected', { socketId: socket.id }));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/build', 'index.html')));

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => logger.info(`Server running on port ${PORT}`));

const shutdown = async () => {
  logger.info('Shutting down server');
  await redis.quit(); // Use redis.js quit
  await mongoose.connection.close();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);