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
if (!process.env.CLOUDINARY_URL) {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary environment variables or CLOUDINARY_URL must be set');
  }
}

// Parse CLOUDYYYY_URL or use individual variables
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
  logger.info('Cloudinary configuration loaded successfully', {
    cloud_name: cloudinaryConfig.cloud_name,
    api_key: cloudinaryConfig.api_key,
  });
} catch (err) {
  logger.error('Cloudinary configuration failed', { error: err.message });
  throw new Error(`Cloudinary configuration failed: ${err.message}`);
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file) return cb(null, true); // Allow no file
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      logger.warn('Invalid file type in Multer', { mimetype: file.mimetype });
      return cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
    cb(null, true);
  },
}).single('photo');

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
    if (!redis.isAvailable()) {
      logger.warn('Redis unavailable, using JWT verification only', { url: req.url });
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      req.user = decoded;
      return next();
    }

    const cachedSession = await redis.get(sessionKey);
    if (cachedSession) {
      req.user = JSON.parse(cachedSession);
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
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
    await redis.del(sessionKey).catch(() => {}); // Ignore Redis errors
    res.status(401).json({ error: 'Invalid token', details: error.message });
  }
};

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  username: Joi.string().min(3).max(20).required(),
  country: Joi.string().length(2).uppercase().required(),
  role: Joi.number().integer().min(0).max(1).required(),
});

const generateVirtualNumber = async (countryCode, userId) => {
  try {
    logger.info('Generating virtual number', { countryCode, userId });
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
      logger.info('Virtual number collision, retrying', { attempt: attempts, virtualNumber });
    } while (attempts < maxAttempts);

    if (attempts >= maxAttempts) {
      throw new Error('Unable to generate unique virtual number after maximum attempts');
    }

    const phoneNumber = parsePhoneNumberFromString(virtualNumber, countryCode.toUpperCase());
    const formattedNumber = phoneNumber ? phoneNumber.formatInternational().replace(/\s/g, '') : virtualNumber;
    logger.info('Virtual number generated', { virtualNumber: formattedNumber });
    return formattedNumber;
  } catch (error) {
    logger.error('Virtual number generation failed', { error: error.message, countryCode, userId });
    throw new Error(`Failed to generate virtual number: ${error.message}`);
  }
};

router.post('/register', authLimiter, (req, res, next) => {
  upload(req, res, (err) => {
    if (err) {
      logger.error('Multer error', { error: err.message, body: req.body });
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    logger.info('Register request received', { email: req.body.email, username: req.body.username });

    // Validate input
    const { error } = registerSchema.validate(req.body);
    if (error) {
      logger.warn('Validation error', { error: error.details[0].message, body: req.body });
      return res.status(400).json({ error: error.details[0].message });
    }

    const { email, password, username, country, role } = req.body;

    // Check for duplicates
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      logger.warn('Duplicate user', { email, username });
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    // Generate RSA keys
    logger.info('Generating RSA key pair', { email });
    const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const publicKeyPem = forge.pki.publicKeyToPem(publicKey);
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);

    // Hash password
    logger.info('Hashing password', { email });
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate virtual number
    let virtualNumber;
    try {
      virtualNumber = await generateVirtualNumber(country, forge.util.bytesToHex(forge.random.getBytesSync(16)));
    } catch (err) {
      return res.status(400).json({ error: 'Failed to generate virtual number', details: err.message });
    }

    // Create user
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

    // Handle photo upload
    if (req.file) {
      logger.info('Uploading photo to Cloudinary', { email, mimetype: req.file.mimetype, size: req.file.size });
      try {
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { resource_type: 'image', folder: 'gapp_profile_photos' },
            (error, result) => (error ? reject(error) : resolve(result))
          ).end(req.file.buffer);
        });
        user.photo = result.secure_url;
        logger.info('Photo uploaded successfully', { email, url: result.secure_url });
      } catch (err) {
        logger.error('Cloudinary upload failed', { error: err.message, email });
        return res.status(400).json({ error: 'Failed to upload photo', details: err.message });
      }
    }

    // Save user
    logger.info('Saving user to MongoDB', { email });
    await user.save();

    // Generate JWT
    logger.info('Generating JWT', { email });
    const token = jwt.sign({ id: user._id, email, virtualNumber, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: '24h',
    });

    // Store token in Redis (if available)
    if (redis.isAvailable()) {
      logger.info('Attempting to store token in Redis', { userId: user._id });
      let redisSuccess = false;
      const maxRetries = 3;
      let attempt = 0;
      while (attempt < maxRetries && !redisSuccess) {
        try {
          await redis.setex(`token:${user._id}`, 24 * 60 * 60, token);
          redisSuccess = true;
          logger.info('Token stored in Redis', { userId: user._id });
        } catch (redisError) {
          attempt++;
          logger.error(`Redis setex failed, attempt ${attempt}`, { error: redisError.message, userId: user._id });
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

// Keep other routes unchanged for brevity
// ... (login, update_country, update_photo, update_username, contacts, public_key, refresh routes as in previous auth.js)

module.exports = { router, authMiddleware };