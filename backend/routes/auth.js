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
const mongoose = require('mongoose');
const User = require('../models/User');
const TokenBlacklist = require('../models/TokenBlacklist');

const router = express.Router();

// Validate environment variables
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not defined');
}
if (!process.env.CLOUDINARY_URL && (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)) {
  throw new Error('Cloudinary environment variables or CLOUDINARY_URL must be set');
}

// Parse CLOUDINARY_URL or use individual variables
let cloudinaryConfig = {};
try {
  if (process.env.CLOUDINARY_URL) {
    const url = new URL(process.env.CLOUDINARY_URL);
    cloudinaryConfig = {
      cloud_name: url.hostname,
      api_key: url.username,
      api_secret: url.password,
    };
  } else {
    cloudinaryConfig = {
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    };
  }
  cloudinary.config(cloudinaryConfig);
} catch (err) {
  throw new Error(`Invalid Cloudinary configuration: ${err.message}`);
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Log Cloudinary configuration
logger.info('Cloudinary configuration loaded', {
  cloud_name: cloudinaryConfig.cloud_name,
  api_key: cloudinaryConfig.api_key,
});

// Multer setup
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // Aligned with social.js
  fileFilter: (req, file, cb) => {
    if (!file) return cb(null, true);
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      logger.warn('Invalid file type', { mimetype: file.mimetype });
      return cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
    cb(null, true);
  },
});

// Rate limiter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // Tightened limit
  message: { error: 'Too many requests, please try again later.' },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, method: req.method, url: req.url });
    res.status(options.statusCode).json(options.message);
  },
});

// Auth middleware
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('No token provided', { method: req.method, url: req.url });
    return res.status(401).json({ error: 'No token provided', code: 'NO_TOKEN' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const blacklisted = await TokenBlacklist.findOne({ token }).select('_id').lean();
    if (blacklisted) {
      logger.warn('Blacklisted token used', { userId: decoded.id });
      return res.status(401).json({ error: 'Token invalidated', code: 'BLACKLISTED_TOKEN' });
    }
    const user = await User.findById(decoded.id).select('_id email virtualNumber role');
    if (!user) {
      logger.warn('User not found', { userId: decoded.id });
      return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Auth middleware error', { error: error.message, token: token.substring(0, 10) + '...', url: req.url });
    res.status(401).json({ error: 'Invalid token', details: error.message, code: 'INVALID_TOKEN' });
  }
};

// Joi schemas
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  username: Joi.string().min(3).max(20).required(),
  country: Joi.string().length(2).uppercase().required(),
  role: Joi.number().integer().min(0).max(1).optional().default(0),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
});

// Virtual number generation
const generateVirtualNumber = async (countryCode, userId) => {
  try {
    logger.info('Generating virtual number', { countryCode, userId });
    const countryCallingCode = getCountryCallingCode(countryCode.toUpperCase());
    let virtualNumber;
    let attempts = 0;
    const maxAttempts = 100; // Increased attempts

    do {
      const randomPart = forge.util.bytesToHex(forge.random.getBytesSync(8)).slice(0, 9);
      virtualNumber = `+${countryCallingCode}${randomPart}`;
      const existingUser = await User.findOne({ virtualNumber }).lean();
      if (!existingUser) break;
      attempts++;
      logger.warn('Virtual number collision', { attempt: attempts, virtualNumber });
      if (attempts >= maxAttempts) {
        throw new Error('Unable to generate unique virtual number after maximum attempts');
      }
    } while (true);

    const phoneNumber = parsePhoneNumberFromString(virtualNumber, countryCode.toUpperCase());
    const formattedNumber = phoneNumber ? phoneNumber.formatInternational().replace(/\s/g, '') : virtualNumber;
    logger.info('Virtual number generated', { virtualNumber: formattedNumber, attempts });
    return formattedNumber;
  } catch (error) {
    logger.error('Virtual number generation failed', { error: error.message, countryCode, userId });
    throw new Error(`Failed to generate virtual number: ${error.message}`);
  }
};

// Routes
router.post('/register', authLimiter, upload.single('photo'), async (req, res) => {
  try {
    logger.info('Register request received', { email: req.body.email, username: req.body.username });
    const { error } = registerSchema.validate(req.body);
    if (error) {
      logger.warn('Validation error', { error: error.details[0].message });
      return res.status(400).json({ error: error.details[0].message, code: 'VALIDATION_ERROR' });
    }

    const { email, password, username, country, role = 0 } = req.body;
    const existingUser = await User.findOne({ $or: [{ email }, { username }] }).lean();
    if (existingUser) {
      logger.warn('Duplicate user', { email, username });
      return res.status(400).json({ error: 'Email or username already exists', code: 'DUPLICATE_USER' });
    }

    const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const publicKeyPem = forge.pki.publicKeyToPem(publicKey);
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);

    const hashedPassword = await bcrypt.hash(password, 10);
    const virtualNumber = await generateVirtualNumber(country, forge.util.bytesToHex(forge.random.getBytesSync(16)));

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
      logger.info('Uploading photo to Cloudinary', { email, mimetype: req.file.mimetype, size: req.file.size });
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'image', folder: 'gapp_profile_photos' },
          (error, result) => (error ? reject(error) : resolve(result))
        ).end(req.file.buffer);
      });
      user.photo = result.secure_url;
    }

    await user.save();
    const token = jwt.sign({ id: user._id, email, virtualNumber, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: '24h',
    });

    logger.info('User registered successfully', { userId: user._id, email });
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
    logger.error('Register error', {
      error: error.message,
      stack: error.stack,
      body: { email: req.body.email, username: req.body.username, country: req.body.country, role: req.body.role },
    });
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Duplicate email, username, or virtual number', code: 'DUPLICATE_KEY' });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: 'Invalid user data', details: error.message, code: 'VALIDATION_ERROR' });
    }
    res.status(500).json({ error: 'Failed to register', details: error.message, code: 'SERVER_ERROR' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { error } = loginSchema.validate(req.body);
    if (error) {
      logger.warn('Validation error', { error: error.details[0].message });
      return res.status(400).json({ error: error.details[0].message, code: 'VALIDATION_ERROR' });
    }

    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+privateKey').lean();
    if (!user) {
      logger.warn('Login attempt with unregistered email', { email });
      return res.status(401).json({ error: 'Email not registered', code: 'EMAIL_NOT_FOUND' });
    }
    if (!(await bcrypt.compare(password, user.password))) {
      logger.warn('Login attempt with wrong password', { email });
      return res.status(401).json({ error: 'Wrong password', code: 'INVALID_PASSWORD' });
    }

    const token = jwt.sign(
      { id: user._id, email, virtualNumber: user.virtualNumber, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info('Login successful', { userId: user._id, email });
    res.json({
      token,
      userId: user._id,
      role: user.role,
      photo: user.photo || 'https://placehold.co/40x40',
      virtualNumber: user.virtualNumber || '',
      username: user.username || '',
      privateKey: user.privateKey,
    });
  } catch (error) {
    logger.error('Login error', { error: error.message, email: req.body.email });
    res.status(500).json({ error: 'Failed to login', details: error.message, code: 'SERVER_ERROR' });
  }
});

router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    await TokenBlacklist.create({ token });
    logger.info('User logged out', { userId: req.user.id });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to logout', details: error.message, code: 'SERVER_ERROR' });
  }
});

router.post('/update_country', authMiddleware, async (req, res) => {
  try {
    const updateCountrySchema = Joi.object({
      userId: Joi.string().required(),
      country: Joi.string().length(2).uppercase().required(),
    });
    const { error } = updateCountrySchema.validate(req.body);
    if (error) {
      logger.warn('Validation error', { error: error.details[0].message });
      return res.status(400).json({ error: error.details[0].message, code: 'VALIDATION_ERROR' });
    }

    const { userId, country } = req.body;
    if (userId !== req.user.id) {
      logger.warn('Unauthorized update country attempt', { userId, reqUserId: req.user.id });
      return res.status(403).json({ error: 'Not authorized', code: 'UNAUTHORIZED' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

    if (user.country !== country) {
      user.country = country;
      user.virtualNumber = await generateVirtualNumber(country, user._id.toString());
      await user.save();
    }

    logger.info('Country updated', { userId, country });
    res.json({ virtualNumber: user.virtualNumber });
  } catch (error) {
    logger.error('Update country error', { error: error.message, userId: req.body.userId });
    res.status(500).json({ error: 'Failed to update country', details: error.message, code: 'SERVER_ERROR' });
  }
});

router.post('/update_photo', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId !== req.user.id) {
      logger.warn('Unauthorized update photo attempt', { userId, reqUserId: req.user.id });
      return res.status(403).json({ error: 'Not authorized', code: 'UNAUTHORIZED' });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo provided', code: 'NO_FILE' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

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
    logger.error('Update photo error', { error: error.message, userId: req.body.userId });
    res.status(500).json({ error: 'Failed to update photo', details: error.message, code: 'SERVER_ERROR' });
  }
});

router.post('/update_username', authMiddleware, async (req, res) => {
  try {
    const updateUsernameSchema = Joi.object({
      userId: Joi.string().required(),
      username: Joi.string().min(3).max(20).required(),
    });
    const { error } = updateUsernameSchema.validate(req.body);
    if (error) {
      logger.warn('Validation error', { error: error.details[0].message });
      return res.status(400).json({ error: error.details[0].message, code: 'VALIDATION_ERROR' });
    }

    const { userId, username } = req.body;
    if (userId !== req.user.id) {
      logger.warn('Unauthorized update username attempt', { userId, reqUserId: req.user.id });
      return res.status(403).json({ error: 'Not authorized', code: 'UNAUTHORIZED' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

    const existingUser = await User.findOne({ username }).lean();
    if (existingUser && existingUser._id.toString() !== userId) {
      return res.status(400).json({ error: 'Username already taken', code: 'DUPLICATE_USERNAME' });
    }

    user.username = username.trim();
    await user.save();

    logger.info('Username updated', { userId, username });
    res.json({ username: user.username });
  } catch (error) {
    logger.error('Update username error', { error: error.message, userId: req.body.userId });
    res.status(500).json({ error: 'Failed to update username', details: error.message, code: 'SERVER_ERROR' });
  }
});

router.get('/contacts', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('contacts', 'username virtualNumber photo status lastSeen')
      .lean();
    if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

    const contacts = user.contacts.map((contact) => ({
      id: contact._id,
      username: contact.username || 'Unknown',
      virtualNumber: contact.virtualNumber || '',
      photo: contact.photo || 'https://placehold.co/40x40',
      status: contact.status || 'offline',
      lastSeen: contact.lastSeen || null,
    }));

    logger.info('Contacts fetched', { userId: req.user.id, contactCount: contacts.length });
    res.json(contacts);
  } catch (error) {
    logger.error('Fetch contacts error', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to fetch contacts', details: error.message, code: 'SERVER_ERROR' });
  }
});

// Public key cache
const publicKeyCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

router.get('/public_key/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'Invalid userId', code: 'INVALID_ID' });
    }

    const cacheKey = `publicKey:${userId}`;
    const cached = publicKeyCache.get(cacheKey);
    if (cached && cached.timestamp > Date.now() - CACHE_TTL) {
      logger.info('Served cached public key', { userId });
      return res.json({ publicKey: cached.publicKey });
    }

    const user = await User.findById(userId).select('publicKey').lean();
    if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

    publicKeyCache.set(cacheKey, { publicKey: user.publicKey, timestamp: Date.now() });
    logger.info('Public key fetched', { userId });
    res.json({ publicKey: user.publicKey });
  } catch (error) {
    logger.error('Fetch public key error', { error: error.message, userId: req.params.userId });
    res.status(500).json({ error: 'Failed to fetch public key', details: error.message, code: 'SERVER_ERROR' });
  }
});

router.post('/refresh', authLimiter, authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    logger.info('Refresh token request', { userId, ip: req.ip });
    if (userId && userId !== req.user.id) {
      logger.warn('Unauthorized refresh attempt', { userId, reqUserId: req.user.id });
      return res.status(403).json({ error: 'Not authorized', code: 'UNAUTHORIZED' });
    }

    const user = await User.findById(req.user.id).select('+privateKey').lean();
    if (!user) {
      logger.warn('User not found during token refresh', { userId: req.user.id });
      return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    const newToken = jwt.sign(
      { id: user._id, email: user.email, virtualNumber: user.virtualNumber, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info('Token refreshed successfully', { userId: user._id });
    res.json({
      token: newToken,
      userId: user._id,
      role: user.role,
      photo: user.photo || 'https://placehold.co/40x40',
      virtualNumber: user.virtualNumber || '',
      username: user.username || '',
      privateKey: user.privateKey,
    });
  } catch (error) {
    logger.error('Refresh token error', { error: error.message, userId: req.user?.id, ip: req.ip });
    res.status(500).json({ error: 'Failed to refresh token', details: error.message, code: 'SERVER_ERROR' });
  }
});

module.exports = { router, authMiddleware };