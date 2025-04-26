const express = require('express');
const jwt = require('jsonwebtoken');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const User = require('../models/user');
const redis = require('../redis');

const router = express.Router(); // Define Express router

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/auth.log' }),
  ],
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests
  message: 'Too many requests, please try again later',
});

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('No token provided', { method: req.method, url: req.url });
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  const sessionKey = `session:${token}`;
  try {
    let cachedSession = null;
    if (redis.isAvailable()) {
      cachedSession = await redis.get(sessionKey);
    }
    if (cachedSession) {
      req.user = JSON.parse(cachedSession);
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    let storedToken = null;
    if (redis.isAvailable()) {
      storedToken = await redis.get(`token:${decoded.id}`);
    }
    if (redis.isAvailable() && storedToken !== token) {
      logger.warn('Token mismatch or invalidated', { userId: decoded.id });
      await redis.del(sessionKey);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (!redis.isAvailable()) {
      // Fallback to database check
      const user = await User.findById(decoded.id);
      if (!user) {
        logger.warn('User not found for token', { userId: decoded.id });
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }
    if (redis.isAvailable()) {
      await redis.setex(sessionKey, 24 * 60 * 60, JSON.stringify(decoded));
    }
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', { error: error.message, token });
    if (redis.isAvailable()) {
      await redis.del(sessionKey);
    }
    res.status(401).json({ error: 'Invalid token' });
  }
};

router.post('/register', authLimiter, async (req, res) => {
  const { username, email, password, role, virtualNumber, photo } = req.body;
  try {
    const existingUser = await User.findOne({ $or: [{ email }, { virtualNumber }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Email or virtual number already in use' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, email, password: hashedPassword, role, virtualNumber, photo });
    await user.save();

    const token = jwt.sign({ id: user._id, email: user.email, virtualNumber: user.virtualNumber, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ userId: user._id, role, token, virtualNumber, username, photo });
  } catch (err) {
    logger.error('Registration error', { error: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id, email: user.email, virtualNumber: user.virtualNumber, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({
      userId: user._id,
      role: user.role,
      token,
      virtualNumber: user.virtualNumber,
      username: user.username,
      photo: user.photo,
      privateKey: user.privateKey,
    });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/refresh', authLimiter, authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId && userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const user = await User.findById(req.user.id).select('+privateKey');
    if (!user) {
      logger.warn('User not found during token refresh', { userId: req.user.id });
      return res.status(401).json({ error: 'User not found' });
    }

    const oldToken = req.headers.authorization.split(' ')[1];
    const newToken = jwt.sign(
      { id: user._id, email: user.email, virtualNumber: user.virtualNumber, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    if (redis.isAvailable()) {
      const maxRetries = 3;
      let attempt = 0;
      let redisSuccess = false;
      while (attempt < maxRetries && !redisSuccess) {
        try {
          await redis.setex(`token:${user._id}`, 24 * 60 * 60, newToken);
          await redis.del(`session:${oldToken}`);
          redisSuccess = true;
        } catch (redisError) {
          attempt++;
          logger.error(`Redis operation failed during token refresh, attempt ${attempt}`, { error: redisError.message });
          if (attempt === maxRetries) {
            logger.warn('Redis unavailable, skipping token cache update');
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
      }
    }

    logger.info('Token refreshed', { userId: user._id });
    res.json({
      token: newToken,
      userId: user._id,
      role: user.role,
      photo: user.photo || 'https://placehold.co/40x40',
      virtualNumber: user.virtualNumber || '',
      username: user.username,
      privateKey: user.privateKey,
    });
  } catch (error) {
    logger.error('Refresh token error:', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: error.message || 'Failed to refresh token' });
  }
});

router.get('/public_key/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ publicKey: user.publicKey });
  } catch (err) {
    logger.error('Public key retrieval error', { error: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { router, authMiddleware };