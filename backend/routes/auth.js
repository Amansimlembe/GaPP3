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
const NodeCache = require('node-cache');
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

// Initialize cache for public keys (TTL: 24 hours)
const publicKeyCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 3600 });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file) return cb(null, true);
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      logger.warn('Invalid file type', { mimetype: file.mimetype, ip: req.ip });
      return cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
    cb(null, true);
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, method: req.method, url: req.url });
    res.status(options.statusCode).json(options.message);
  },
});

const retryOperation = async (operation, maxRetries = 3, baseDelay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt) * baseDelay * (1 + Math.random() * 0.1);
      logger.warn('Retrying operation', { attempt, error: err.message, url: operation.name || 'anonymous' });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

const errorLogTimestamps = new Map();

const logError = async (message, metadata = {}) => {
  const now = Date.now();
  const errorEntry = errorLogTimestamps.get(message) || { count: 0, timestamps: [] };
  errorEntry.timestamps = errorEntry.timestamps.filter((ts) => now - ts < 60 * 1000);
  if (errorEntry.count >= 1 || errorEntry.timestamps.length >= 5) {
    logger.info(`Error logging skipped for "${message}": rate limit reached`, metadata);
    return;
  }
  const isCritical = message.includes('Unauthorized') || message.includes('failed after max retries') || message.includes('Invalid');
  if (!isCritical) {
    return;
  }
  errorEntry.count += 1;
  errorEntry.timestamps.push(now);
  errorLogTimestamps.set(message, errorEntry);
  logger.error(message, { ...metadata, timestamp: new Date().toISOString() });
};

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    await logError('No token provided', { method: req.method, url: req.url, ip: req.ip });
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const blacklisted = await retryOperation(async () => {
      return await TokenBlacklist.findOne({ token }).lean();
    });
    if (blacklisted) {
      await logError('Blacklisted token used', { token: token.substring(0, 10) + '...', url: req.url, ip: req.ip });
      return res.status(401).json({ error: 'Token is blacklisted' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded.id || !mongoose.isValidObjectId(decoded.id)) {
      await logError('Invalid or missing user ID in token', { userId: decoded.id, url: req.url, ip: req.ip });
      return res.status(401).json({ error: 'Invalid token: Invalid user ID' });
    }

    const user = await retryOperation(async () => {
      return await User.findById(decoded.id).select('_id email virtualNumber role').lean();
    });
    if (!user) {
      await logError('User not found for token', { userId: decoded.id, url: req.url, ip: req.ip });
      return res.status(401).json({ error: 'Invalid token: User not found' });
    }

    req.user = {
      _id: user._id.toString(),
      id: user._id.toString(),
      email: user.email,
      virtualNumber: user.virtualNumber,
      role: user.role,
    };
    req.token = token;
    logger.info('Authentication successful', { userId: user._id, url: req.url, ip: req.ip });
    next();
  } catch (error) {
    await logError('Auth middleware error', {
      error: error.message,
      token: token.substring(0, 10) + '...',
      url: req.url,
      ip: req.ip,
      stack: error.stack,
    });
    res.status(401).json({ error: 'Invalid token', details: error.message });
  }
};

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  username: Joi.string().min(3).max(20).required(),
  country: Joi.string().length(2).uppercase().required(),
  role: Joi.number().integer().min(0).max(1).optional().default(0),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
});

const generateVirtualNumber = async (countryCode, userId) => {
  try {
    const countryCallingCode = getCountryCallingCode(countryCode.toUpperCase());
    let virtualNumber;
    let attempts = 0;
    const maxAttempts = 20;

    do {
      const randomDigits = Math.floor(100000000 + Math.random() * 900000000).toString();
      virtualNumber = `+${countryCallingCode}${randomDigits}`;
      const existingUser = await User.findOne({ virtualNumber }).lean();
      if (!existingUser) break;
      attempts++;
      await logError('Virtual number collision', { attempt: attempts, virtualNumber, userId });
      if (attempts >= maxAttempts) {
        throw new Error('Unable to generate unique virtual number after maximum attempts');
      }
    } while (true);

    const phoneNumber = parsePhoneNumberFromString(virtualNumber, countryCode.toUpperCase());
    const formattedNumber = phoneNumber ? phoneNumber.formatInternational().replace(/\s/g, '') : virtualNumber;
    logger.info('Virtual number generated', { virtualNumber: formattedNumber, attempts, userId });
    return formattedNumber;
  } catch (error) {
    await logError('Virtual number generation failed', { error: error.message, countryCode, userId });
    throw new Error(`Failed to generate virtual number: ${error.message}`);
  }
};

router.post('/register', authLimiter, upload.single('photo'), async (req, res) => {
  try {
    const { error } = registerSchema.validate(req.body);
    if (error) {
      await logError('Validation error', { error: error.details[0].message, body: req.body, ip: req.ip });
      return res.status(400).json({ error: error.details[0].message });
    }

    const { email, password, username, country, role = 0 } = req.body;

    const existingUser = await retryOperation(async () => {
      return await User.findOne({ $or: [{ email }, { username }] }).lean();
    });
    if (existingUser) {
      const errorMsg = existingUser.email === email ? 'Email already exists' : 'Username already exists';
      await logError('Duplicate user', { email, username, ip: req.ip });
      return res.status(400).json({ error: errorMsg });
    }

    const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const publicKeyPem = forge.pki.publicKeyToPem(publicKey);
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);

    // Validate generated keys
    try {
      forge.pki.publicKeyFromPem(publicKeyPem);
      forge.pki.privateKeyFromPem(privateKeyPem);
    } catch (err) {
      await logError('Invalid RSA key pair generated', { error: err.message, userId: 'new_user', ip: req.ip });
      return res.status(500).json({ error: 'Failed to generate encryption keys', details: err.message });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    let virtualNumber;
    try {
      virtualNumber = await generateVirtualNumber(country, forge.util.bytesToHex(forge.random.getBytesSync(16)));
    } catch (err) {
      await logError('Failed to generate virtual number', { error: err.message, country, ip: req.ip });
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
      const result = await retryOperation(async () => {
        return await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { resource_type: 'image', folder: 'gapp_profile_photos' },
            (error, result) => (error ? reject(error) : resolve(result))
          ).end(req.file.buffer);
        });
      });
      user.photo = result.secure_url;
    }

    await retryOperation(async () => {
      await user.save();
    });

    const token = jwt.sign(
      { id: user._id.toString(), email, virtualNumber, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h', algorithm: 'HS256' }
    );

    logger.info('User registered successfully', { userId: user._id, email, ip: req.ip });
    res.status(201).json({
      token,
      userId: user._id.toString(),
      role: user.role,
      photo: user.photo,
      virtualNumber: user.virtualNumber,
      username: user.username,
      privateKey: privateKeyPem,
    });
  } catch (error) {
    await logError('Register error', {
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
      ip: req.ip,
    });
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        error: `Duplicate ${field}: ${req.body[field] || 'value'} already exists`,
      });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: 'Invalid user data', details: error.message });
    }
    res.status(500).json({ error: 'Failed to register', details: error.message });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { error } = loginSchema.validate(req.body);
    if (error) {
      await logError('Validation error', { error: error.details[0].message, body: req.body, ip: req.ip });
      return res.status(400).json({ error: error.details[0].message });
    }

    const { email, password } = req.body;
    const user = await retryOperation(async () => {
      return await User.findOne({ email }).select('+password +privateKey').lean();
    });
    if (!user) {
      await logError('Login attempt with unregistered email', { email, ip: req.ip });
      return res.status(401).json({ error: 'Email not registered' });
    }
    if (!(await bcrypt.compare(password, user.password))) {
      await logError('Login attempt with wrong password', { email, ip: req.ip });
      return res.status(401).json({ error: 'Wrong password' });
    }

    const token = jwt.sign(
      { id: user._id.toString(), email, virtualNumber: user.virtualNumber, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h', algorithm: 'HS256' }
    );

    await retryOperation(async () => {
      await User.updateOne(
        { _id: user._id },
        { $set: { status: 'online', lastSeen: new Date() } }
      );
    });

    logger.info('Login successful', { userId: user._id, email, ip: req.ip });
    res.json({
      token,
      userId: user._id.toString(),
      role: user.role,
      photo: user.photo || 'https://placehold.co/40x40',
      virtualNumber: user.virtualNumber || '',
      username: user.username || '',
      privateKey: user.privateKey,
    });
  } catch (error) {
    await logError('Login error', { error: error.message, stack: error.stack, body: req.body, ip: req.ip });
    res.status(500).json({ error: 'Failed to login', details: error.message });
  }
});

router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const token = req.token;
    if (!token) {
      await logError('No token provided for logout', { userId: req.user.id, ip: req.ip });
      return res.status(400).json({ error: 'No token provided' });
    }

    await retryOperation(async () => {
      await TokenBlacklist.create({ token });
    });

    await retryOperation(async () => {
      await User.updateOne(
        { _id: req.user.id },
        { $set: { status: 'offline', lastSeen: new Date() } }
      );
    });

    logger.info('Logout successful', { userId: req.user.id, ip: req.ip });
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    await logError('Logout error', { error: error.message, userId: req.user?.id, stack: error.stack, ip: req.ip });
    res.status(500).json({ error: 'Failed to logout', details: error.message });
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
      await logError('Validation error', { error: error.details[0].message, body: req.body, ip: req.ip });
      return res.status(400).json({ error: error.details[0].message });
    }

    const { userId, country } = req.body;
    if (userId !== req.user.id) {
      await logError('Unauthorized country update attempt', { userId, reqUserId: req.user.id, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!mongoose.isValidObjectId(userId)) {
      await logError('Invalid user ID', { userId, ip: req.ip });
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const user = await retryOperation(async () => {
      return await User.findById(userId);
    });
    if (!user) {
      await logError('User not found', { userId, ip: req.ip });
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.country !== country) {
      user.country = country;
      user.virtualNumber = await generateVirtualNumber(country, user._id.toString());
      await retryOperation(async () => {
        await user.save();
      });
    }

    logger.info('Country updated', { userId, country, virtualNumber: user.virtualNumber, ip: req.ip });
    res.json({ virtualNumber: user.virtualNumber });
  } catch (error) {
    await logError('Update country error', { error: error.message, stack: error.stack, userId: req.body.userId, ip: req.ip });
    res.status(500).json({ error: 'Failed to update country', details: error.message });
  }
});

router.post('/update_photo', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId !== req.user.id) {
      await logError('Unauthorized photo update attempt', { userId, reqUserId: req.user.id, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (!req.file) {
      await logError('No photo provided', { userId, ip: req.ip });
      return res.status(400).json({ error: 'No photo provided' });
    }

    if (!mongoose.isValidObjectId(userId)) {
      await logError('Invalid user ID', { userId, ip: req.ip });
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const user = await retryOperation(async () => {
      return await User.findById(userId);
    });
    if (!user) {
      await logError('User not found', { userId, ip: req.ip });
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await retryOperation(async () => {
      return await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'image', folder: 'gapp_profile_photos' },
          (error, result) => (error ? reject(error) : resolve(result))
        ).end(req.file.buffer);
      });
    });

    user.photo = result.secure_url;
    await retryOperation(async () => {
      await user.save();
    });

    logger.info('Photo updated', { userId, photo: user.photo, ip: req.ip });
    res.json({ photo: user.photo });
  } catch (error) {
    await logError('Update photo error', { error: error.message, stack: error.stack, userId: req.body.userId, ip: req.ip });
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
    if (error) {
      await logError('Validation error', { error: error.details[0].message, body: req.body, ip: req.ip });
      return res.status(400).json({ error: error.details[0].message });
    }

    const { userId, username } = req.body;
    if (userId !== req.user.id) {
      await logError('Unauthorized username update attempt', { userId, reqUserId: req.user.id, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!mongoose.isValidObjectId(userId)) {
      await logError('Invalid user ID', { userId, ip: req.ip });
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const user = await retryOperation(async () => {
      return await User.findById(userId);
    });
    if (!user) {
      await logError('User not found', { userId, ip: req.ip });
      return res.status(404).json({ error: 'User not found' });
    }

    const existingUser = await retryOperation(async () => {
      return await User.findOne({ username }).lean();
    });
    if (existingUser && existingUser._id.toString() !== userId) {
      await logError('Username already taken', { username, userId, ip: req.ip });
      return res.status(400).json({ error: 'Username already taken' });
    }

    user.username = username.trim();
    await retryOperation(async () => {
      await user.save();
    });

    logger.info('Username updated', { userId, username, ip: req.ip });
    res.json({ username: user.username });
  } catch (error) {
    await logError('Update username error', { error: error.message, stack: error.stack, userId: req.body.userId, ip: req.ip });
    res.status(500).json({ error: 'Failed to update username', details: error.message });
  }
});

router.get('/contacts', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const user = await retryOperation(async () => {
      return await User.findById(req.user.id)
        .populate({
          path: 'contacts',
          select: 'username virtualNumber photo status lastSeen',
          options: { skip, limit: parseInt(limit) },
        })
        .lean();
    });
    if (!user) {
      await logError('User not found', { userId: req.user.id, ip: req.ip });
      return res.status(404).json({ error: 'User not found' });
    }

    const contacts = user.contacts.map((contact) => ({
      id: contact._id.toString(),
      username: contact.username,
      virtualNumber: contact.virtualNumber,
      photo: contact.photo || 'https://placehold.co/40x40',
      status: contact.status,
      lastSeen: contact.lastSeen,
    }));

    const totalContacts = user.contacts.length;
    logger.info('Contacts fetched', { userId: req.user.id, page, limit, totalContacts, ip: req.ip });
    res.json({
      contacts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalContacts,
        pages: Math.ceil(totalContacts / parseInt(limit)),
      },
    });
  } catch (error) {
    await logError('Fetch contacts error', { error: error.message, stack: error.stack, userId: req.user.id, ip: req.ip });
    res.status(500).json({ error: 'Failed to fetch contacts', details: error.message });
  }
});

router.get('/public_key/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      await logError('Invalid user ID', { userId, ip: req.ip });
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const cacheKey = `publicKey:${userId}`;
    const cachedKey = publicKeyCache.get(cacheKey);
    if (cachedKey) {
      logger.info('Public key served from cache', { userId, ip: req.ip });
      return res.json({ publicKey: cachedKey });
    }

    const user = await retryOperation(async () => {
      return await User.findById(userId).select('publicKey').lean();
    });
    if (!user || !user.publicKey) {
      await logError('User or public key not found', { userId, ip: req.ip });
      return res.status(404).json({ error: 'User or public key not found' });
    }

    // Validate public key
    try {
      forge.pki.publicKeyFromPem(user.publicKey);
    } catch (err) {
      await logError('Invalid public key format', { userId, error: err.message, ip: req.ip });
      return res.status(500).json({ error: 'Invalid public key format', details: err.message });
    }

    publicKeyCache.set(cacheKey, user.publicKey);
    logger.info('Public key fetched and cached', { userId, ip: req.ip });
    res.json({ publicKey: user.publicKey });
  } catch (error) {
    await logError('Fetch public key error', { error: error.message, userId: req.params.userId, stack: error.stack, ip: req.ip });
    res.status(500).json({ error: 'Failed to fetch public key', details: error.message });
  }
});

router.post('/refresh', authLimiter, authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId && userId !== req.user.id) {
      await logError('Unauthorized refresh attempt', { userId, reqUserId: req.user.id, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!mongoose.isValidObjectId(req.user.id)) {
      await logError('Invalid user ID in token', { userId: req.user.id, ip: req.ip });
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await retryOperation(async () => {
      return await User.findById(req.user.id).select('+privateKey').lean();
    });
    if (!user) {
      await logError('User not found during token refresh', { userId: req.user.id, ip: req.ip });
      return res.status(401).json({ error: 'User not found' });
    }

    const oldToken = req.token;
    if (oldToken) {
      await retryOperation(async () => {
        await TokenBlacklist.create({ token: oldToken });
      });
      logger.info('Old token blacklisted during refresh', { userId: req.user.id, ip: req.ip });
    }

    const newToken = jwt.sign(
      { id: user._id.toString(), email: user.email, virtualNumber: user.virtualNumber, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h', algorithm: 'HS256' }
    );

    logger.info('Token refreshed successfully', { userId: user._id, ip: req.ip });
    res.json({
      token: newToken,
      userId: user._id.toString(),
      role: user.role,
      photo: user.photo || 'https://placehold.co/40x40',
      virtualNumber: user.virtualNumber || '',
      username: user.username || '',
      privateKey: user.privateKey,
    });
  } catch (error) {
    await logError('Refresh token error', { error: error.message, stack: error.stack, userId: req.user?.id, ip: req.ip });
    res.status(500).json({ error: 'Failed to refresh token', details: error.message });
  }
});

module.exports = { router, authMiddleware };