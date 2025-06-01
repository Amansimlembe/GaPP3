const express = require('express');
const jwt = require('jsonwebtoken');
const forge = require('node-forge');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { getCountryCallingCode, parsePhoneNumberFromString } = require('libphonenumber-js');
const Joi = require('joi');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const redis = require('../redis');

const router = express.Router();

// Validate environment variables
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not defined');
}

// Parse CLOUDINARY_URL or use individual variables
let cloudinaryConfig = {};
if (process.env.CLOUDINARY_URL) {
  try {
    const url = new URL(process.env.CLOUDINARY_URL);
    cloudinaryConfig = {
      cloud_name: url.hostname,
      api_key: url.username,
      api_secret: url.password,
    };
  } catch (err) {
    throw new Error(`Invalid CLOUDINARY_URL format: ${err.message}`);
  }
} else if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinaryConfig = {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  };
} else {
  throw new Error('Cloudinary environment variables or CLOUDINARY_URL are not set');
}

cloudinary.config(cloudinaryConfig);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Log Cloudinary configuration (omit api_secret for security)
logger.info('Cloudinary configuration loaded', {
  cloud_name: cloudinaryConfig.cloud_name,
  api_key: cloudinaryConfig.api_key,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!file) return cb(null, true); // Allow no file
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
    cb(null, true);
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many requests, please try again later.' },
});

// Updated authMiddleware with Redis fallback
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('No token provided', { method: req.method, url: req.url });
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  const sessionKey = `session:${token}`;
  try {
    // Fallback to JWT verification if Redis is unavailable
    if (!redis.isAvailable()) {
      logger.warn('Redis unavailable, using JWT verification only', { url: req.url });
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        req.user = decoded;
        return next();
      } catch (jwtError) {
        logger.error('JWT verification failed in Redis fallback', { error: jwtError.message, token: token.substring(0, 10) + '...' });
        return res.status(401).json({ error: 'Invalid token', details: jwtError.message });
      }
    }

    const cachedSession = await redis.get(sessionKey);
    if (cachedSession) {
      req.user = JSON.parse(cachedSession);
      return next();
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (jwtError) {
      logger.error('JWT verification failed', { error: jwtError.message, token: token.substring(0, 10) + '...' });
      await redis.del(sessionKey);
      return res.status(401).json({ error: 'Invalid token', details: jwtError.message });
    }

    const storedToken = await redis.get(`token:${decoded.id}`);
    if (storedToken !== token) {
      logger.warn('Token mismatch or invalidated', { userId: decoded.id, token: token.substring(0, 10) + '...' });
      await redis.del(sessionKey);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    await redis.setex(sessionKey, 24 * 60 * 60, JSON.stringify(decoded));
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', { error: error.message, token: token.substring(0, 10) + '...', url: req.url });
    await redis.del(sessionKey);
    res.status(401).json({ error: 'Invalid token', details: error.message });
  }
};

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  username: Joi.string().min(3).max(20).required(),
  country: Joi.string().length(2).required(), // ISO 3166-1 alpha-2
  role: Joi.number().integer().min(0).max(1).required(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
});

const generateVirtualNumber = async (countryCode, userId) => {
  try {
    const countryCallingCode = getCountryCallingCode(countryCode.toUpperCase());
    let virtualNumber;
    let attempts = 0;
    const maxAttempts = 10;

    do {
      const numericPart = Math.floor(Math.random() * 1000000000).toString().padStart(9, '0');
      virtualNumber = `+${countryCallingCode}${numericPart}`;
      const existingUser = await User.findOne({ virtualNumber });
      if (!existingUser) break;
      attempts++;
    } while (attempts < maxAttempts);

    if (attempts >= maxAttempts) {
      throw new Error('Unable to generate unique virtual number after maximum attempts');
    }

    const phoneNumber = parsePhoneNumberFromString(virtualNumber, countryCode.toUpperCase());
    return phoneNumber ? phoneNumber.formatInternational().replace(/\s/g, '') : virtualNumber;
  } catch (error) {
    throw new Error(`Failed to generate virtual number: ${error.message}`);
  }
};

router.post('/register', authLimiter, upload.single('photo'), async (req, res) => {
  try {
    const { email, password, username, country, role } = req.body;
    const { error } = registerSchema.validate({ email, password, username, country, role });
    if (error) {
      logger.warn('Validation error', { error: error.details[0].message, body: req.body });
      return res.status(400).json({ error: error.details[0].message });
    }

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      logger.warn('Duplicate user', { email, username });
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const publicKeyPem = forge.pki.publicKeyToPem(publicKey);
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);

    const hashedPassword = await bcrypt.hash(password, 10);
    let virtualNumber;
    try {
      virtualNumber = await generateVirtualNumber(country, forge.util.bytesToHex(forge.random.getBytesSync(16)));
    } catch (err) {
      logger.error('Virtual number generation failed', { error: err.message, country });
      return res.status(400).json({ error: 'Failed to generate virtual number', details: err.message });
    }

    const user = new User({
      email,
      password: hashedPassword,
      username,
      country,
      virtualNumber,
      publicKey: publicKeyPem,
      privateKey: privateKeyPem,
      photo: 'https://placehold.co/40x40',
      role: parseInt(role),
    });

    if (req.file) {
      try {
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { resource_type: 'image', folder: 'gapp_profile_photos' },
            (error, result) => (error ? reject(error) : resolve(result))
          ).end(req.file.buffer);
        });
        user.photo = result.secure_url;
        logger.info('Photo uploaded to Cloudinary', { email, url: result.secure_url });
      } catch (err) {
        logger.error('Cloudinary upload failed', { error: err.message, email });
        return res.status(400).json({ error: 'Failed to upload photo', details: err.message });
      }
    }

    await user.save();
    const token = jwt.sign({ id: user._id, email, virtualNumber, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: '24h',
    });

    // Handle Redis with retries and fallback
    let redisSuccess = false;
    const maxRetries = 3;
    let attempt = 0;
    if (redis.isAvailable()) {
      while (attempt < maxRetries && !redisSuccess) {
        try {
          await redis.setex(`token:${user._id}`, 24 * 60 * 60, token);
          redisSuccess = true;
          logger.info('Token stored in Redis', { userId: user._id });
        } catch (redisError) {
          attempt++;
          logger.error(`Redis setex failed during registration, attempt ${attempt}`, {
            error: redisError.message,
            userId: user._id,
          });
          if (attempt === maxRetries) {
            logger.warn('Redis unavailable after max retries, proceeding without caching', { userId: user._id });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
      }
    } else {
      logger.warn('Redis unavailable, skipping token storage', { userId: user._id });
    }

    logger.info('User registered', { userId: user._id, email });
    res.status(201).json({
      token,
      userId: user._id,
      role: user.role,
      photo: user.photo,
      virtualNumber: user.virtualNumber,
      username: user.username,
      privateKey: privateKeyPem,
    });
  } catch (error) {
    logger.error('Register error:', {
      error: error.message,
      stack: error.stack,
      body: {
        email: req.body.email,
        username: req.body.username,
        country: req.body.country,
        role: req.body.role,
        hasPhoto: !!req.file,
      },
      file: req.file ? { mimetype: req.file.mimetype, size: req.file.size } : null,
    });
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Duplicate email, username, or virtual number' });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: 'Invalid user data', details: error.message });
    }
    res.status(500).json({ error: 'Failed to register', details: error.message });
  }
});

// Keep other routes unchanged
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { error } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+privateKey');
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user._id, email, virtualNumber: user.virtualNumber, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    let redisSuccess = false;
    const maxRetries = 3;
    let attempt = 0;
    if (redis.isAvailable()) {
      while (attempt < maxRetries && !redisSuccess) {
        try {
          await redis.setex(`token:${user._id}`, 24 * 60 * 60, token);
          redisSuccess = true;
        } catch (redisError) {
          attempt++;
          logger.error(`Redis setex failed during login, attempt ${attempt}`, { error: redisError.message });
          if (attempt === maxRetries) {
            logger.warn('Redis unavailable after max retries, proceeding without caching', { userId: user._id });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
      }
    } else {
      logger.warn('Redis unavailable, skipping token storage', { userId: user._id });
    }

    logger.info('Login successful', { userId: user._id, email });
    res.json({
      token,
      userId: user._id,
      role: user.role,
      photo: user.photo || 'https://placehold.co/40x40',
      virtualNumber: user.virtualNumber || '',
      username: user.username,
      privateKey: user.privateKey,
    });
  } catch (error) {
    logger.error('Login error', { error: error.message, body: req.body });
    res.status(500).json({ error: 'Failed to login', details: error.message });
  }
});

router.post('/update_country', authMiddleware, async (req, res) => {
  try {
    const updateCountrySchema = Joi.object({
      userId: Joi.string().required(),
      country: Joi.string().required(),
    });
    const { error } = updateCountrySchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { userId, country } = req.body;
    if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.country !== country) {
      user.country = country;
      user.virtualNumber = await generateVirtualNumber(country, user._id.toString());
      await user.save();
    }

    logger.info('Country updated', { userId, country });
    res.json({ virtualNumber: user.virtualNumber });
  } catch (error) {
    logger.error('Update country error:', { error: error.message, userId: req.body.userId });
    res.status(500).json({ error: 'Failed to update country', details: error.message });
  }
});

router.post('/update_photo', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    if (!req.file) return res.status(400).json({ error: 'No photo provided' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'image', folder: 'gapp_profile_photos' },
        (error, result) => (error ? reject(error) : resolve(result))
      ).end(req.file.buffer);
    });

    user.photo = result.secure_url;
    await user.save();

    logger.info('Photo updated', { userId });
    res.json({ photo: user.photo });
  } catch (error) {
    logger.error('Update photo error:', { error: error.message, userId: req.body.userId });
    res.status(500).json({ error: 'Failed to update photo', details: error.message });
  }
});

router.post('/update_username', authMiddleware, async (req, res) => {
  try {
    const updateUsernameSchema = Joi.object({
      userId: Joi.string().required(),
      username: Joi.string().min(3).max(20).required(),
    });
    const { error } = updateUsernameSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { userId, username } = req.body;
    if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existingUser = await User.findOne({ username });
    if (existingUser && existingUser._id.toString() !== userId) return res.status(400).json({ error: 'Username already taken' });

    user.username = username.trim();
    await user.save();

    logger.info('Username updated', { userId, username });
    res.json({ username: user.username });
  } catch (error) {
    logger.error('Update username error:', { error: error.message, userId: req.body.userId });
    res.status(500).json({ error: 'Failed to update username', details: error.message });
  }
});

router.get('/contacts', authMiddleware, async (req, res) => {
  try {
    const cacheKey = `contacts:${req.user.id}`;
    let contacts;
    if (redis.isAvailable()) {
      const cachedContacts = await redis.get(cacheKey);
      if (cachedContacts) return res.json(JSON.parse(cachedContacts));
    }

    const user = await User.findById(req.user.id).populate('contacts', 'username virtualNumber photo status lastSeen');
    if (!user) return res.status(404).json({ error: 'User not found' });

    contacts = user.contacts.map((contact) => ({
      id: contact._id,
      username: contact.username,
      virtualNumber: contact.virtualNumber,
      photo: contact.photo || 'https://placehold.co/40x40',
      status: contact.status,
      lastSeen: contact.lastSeen,
    }));

    if (redis.isAvailable()) {
      await redis.setex(cacheKey, 300, JSON.stringify(contacts));
    }

    res.json(contacts);
  } catch (error) {
    logger.error('Fetch contacts error', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to fetch contacts', details: error.message });
  }
});

router.get('/public_key/:userId', authMiddleware, async (req, res) => {
  try {
    const cacheKey = `publicKey:${req.params.userId}`;
    let publicKey;
    if (redis.isAvailable()) {
      const cachedKey = await redis.get(cacheKey);
      if (cachedKey) return res.json({ publicKey: cachedKey });
    }

    const user = await User.findById(req.params.userId).select('publicKey');
    if (!user) return res.status(404).json({ error: 'User not found' });

    publicKey = user.publicKey;
    if (redis.isAvailable()) {
      await redis.setex(cacheKey, 3600, publicKey);
    }

    res.json({ publicKey });
  } catch (error) {
    logger.error('Fetch public key error:', { error: error.message, userId: req.params.userId });
    res.status(500).json({ error: 'Failed to fetch public key', details: error.message });
  }
});

router.post('/refresh', authLimiter, authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    logger.info('Refresh token request', { userId, ip: req.ip });
    if (userId && userId !== req.user.id) {
      logger.warn('Unauthorized refresh attempt', { userId, reqUserId: req.user.id });
      return res.status(403).json({ error: 'Not authorized' });
    }

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

    let redisSuccess = false;
    const maxRetries = 3;
    let attempt = 0;
    if (redis.isAvailable()) {
      while (attempt < maxRetries && !redisSuccess) {
        try {
          await redis.setex(`token:${user._id}`, 24 * 60 * 60, newToken);
          await redis.del(`session:${oldToken}`);
          redisSuccess = true;
        } catch (redisError) {
          attempt++;
          logger.error(`Redis operation failed during token refresh, attempt ${attempt}`, { error: redisError.message });
          if (attempt === maxRetries) {
            logger.warn('Redis unavailable after max retries, proceeding without caching', { userId: user._id });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
      }
    } else {
      logger.warn('Redis unavailable, skipping token storage', { userId: user._id });
    }

    logger.info('Token refreshed successfully', { userId: user._id });
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
    logger.error('Refresh token error:', { error: error.message, userId: req.user?.id, ip: req.ip });
    res.status(500).json({ error: 'Failed to refresh token', details: error.message });
  }
});

module.exports = { router, authMiddleware };