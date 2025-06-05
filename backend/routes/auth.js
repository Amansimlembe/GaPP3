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

// Log Cloudinary configuration (omit api_secret for security)
logger.info('Cloudinary configuration loaded', {
  cloud_name: cloudinaryConfig.cloud_name,
  api_key: cloudinaryConfig.api_key,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file) return cb(null, true); // Allow no file
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      logger.warn('Invalid file type', { mimetype: file.mimetype });
      return cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
    cb(null, true);
  },
});


const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // Increased to 100
  message: { error: 'Too many requests, please try again later.' },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, method: req.method, url: req.url });
    res.status(options.statusCode).json(options.message);
  },
});



// Updated authMiddleware without Redis
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('No token provided', { method: req.method, url: req.url });
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', { error: error.message, token: token.substring(0, 10) + '...', url: req.url });
    res.status(401).json({ error: 'Invalid token', details: error.message });
  }
};

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



const generateVirtualNumber = async (countryCode, userId) => {
  try {
    logger.info('Generating virtual number', { countryCode, userId });
    const countryCallingCode = getCountryCallingCode(countryCode.toUpperCase());
    let virtualNumber;
    let attempts = 0;
    const maxAttempts = 20; // Increased attempts

    do {
      let firstFive = '';
      for (let i = 0; i < 5; i++) {
        firstFive += Math.floor(Math.random() * 9) + 1;
      }
      const remainingFour = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      virtualNumber = `+${countryCallingCode}${firstFive}${remainingFour}`;
      const existingUser = await User.findOne({ virtualNumber });
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


router.post('/register', authLimiter, upload.single('photo'), async (req, res) => {
  try {
    logger.info('Register request received', { email: req.body.email, username: req.body.username });

    const { error } = registerSchema.validate(req.body);
    if (error) {
      logger.warn('Validation error', { error: error.details[0].message, body: req.body });
      return res.status(400).json({ error: error.details[0].message });
    }

    const { email, password, username, country, role = 0 } = req.body;

    logger.info('Checking for existing user', { email, username });
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      logger.warn('Duplicate user', { email, username });
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    logger.info('Generating RSA key pair', { email });
    const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const publicKeyPem = forge.pki.publicKeyToPem(publicKey);
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);

    logger.info('Hashing password', { email });
    const hashedPassword = await bcrypt.hash(password, 10);

    let virtualNumber;
    try {
      logger.info('Generating virtual number', { email, country });
      virtualNumber = await generateVirtualNumber(country, forge.util.bytesToHex(forge.random.getBytesSync(16)));
    } catch (err) {
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

    logger.info('Saving user to MongoDB', { email });
    await user.save();

    logger.info('Generating JWT', { email });
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

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { error } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+privateKey');
    if (!user) {
      logger.warn('Login attempt with unregistered email', { email });
      return res.status(401).json({ error: 'Email not registered' });
    }
    if (!(await bcrypt.compare(password, user.password))) {
      logger.warn('Login attempt with wrong password', { email });
      return res.status(401).json({ error: 'Wrong password' });
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
    const user = await User.findById(req.user.id).populate('contacts', 'username virtualNumber photo status lastSeen');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const contacts = user.contacts.map((contact) => ({
      id: contact._id,
      username: contact.username,
      virtualNumber: contact.virtualNumber,
      photo: contact.photo || 'https://placehold.co/40x40',
      status: contact.status,
      lastSeen: contact.lastSeen,
    }));

    res.json(contacts);
  } catch (error) {
    logger.error('Fetch contacts error', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to fetch contacts', details: error.message });
  }
});

router.get('/public_key/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('publicKey');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ publicKey: user.publicKey });
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
    logger.error('Refresh token error:', { error: error.message, userId: req.user?.id, ip: req.ip });
    res.status(500).json({ error: 'Failed to refresh token', details: error.message });
  }
});

module.exports = { router, authMiddleware };