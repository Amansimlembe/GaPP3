require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
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
  ],
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});
app.set('io', io);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const buildPath = path.join(__dirname, '../frontend/build'); // Adjusted to go up from backend/ to root
logger.info(`Attempting to serve static files from: ${buildPath}`);
app.use(express.static(buildPath));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

// JSON parsing error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.error('Invalid JSON payload', { method: req.method, url: req.url, body: req.body, error: err.message });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

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

// Fallback for client-side routing
app.get('*', (req, res) => {
  const indexPath = path.join(buildPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      logger.error('Failed to serve index.html', { path: indexPath, error: err.message });
      res.status(500).send('Server Error - Static files may not be built correctly');
    }
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal Server Error' });
});

io.on('connection', (socket) => {
  logger.info('User connected', { socketId: socket.id });

  socket.on('join', (userId) => {
    socket.join(userId);
    logger.info('User joined room', { userId, socketId: socket.id });
  });

  socket.on('disconnect', () => {
    logger.info('User disconnected', { socketId: socket.id });
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => logger.info(`Server running on port ${PORT}`));

const shutdown = async () => {
  logger.info('Shutting down server');
  await redis.quit();
  await mongoose.connection.close();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);