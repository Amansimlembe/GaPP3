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

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
    cb(null, true);
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('No token provided', { method: req.method, url: req.url });
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  const sessionKey = `session:${token}`;
  const cachedSession = await redis.get(sessionKey);

  if (cachedSession) {
    req.user = JSON.parse(cachedSession);
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const storedToken = await redis.get(`token:${decoded.id}`);
    if (storedToken !== token) {
      logger.warn('Token mismatch or invalidated', { userId: decoded.id });
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    await redis.setex(sessionKey, 24 * 60 * 60, JSON.stringify(decoded));
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', { error: error.message, token });
    res.status(401).json({ error: 'Invalid token' });
  }
};

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  username: Joi.string().min(3).max(20).required(),
  country: Joi.string().required(),
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
    if (error) return res.status(400).json({ error: error.details[0].message });

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) return res.status(400).json({ error: 'Email or username already exists' });

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
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'image', folder: 'gapp_profile_photos' },
          (error, result) => (error ? reject(error) : resolve(result))
        ).end(req.file.buffer);
      });
      user.photo = result.secure_url;
    }

    await user.save();
    const token = jwt.sign({ id: user._id, email, virtualNumber, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    await redis.setex(`token:${user._id}`, 24 * 60 * 60, token);

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
    logger.error('Register error:', { error: error.message, body: req.body });
    if (error.code === 11000) return res.status(400).json({ error: 'Duplicate email, username, or virtual number' });
    res.status(500).json({ error: error.message || 'Failed to register' });
  }
});

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
    await redis.setex(`token:${user._id}`, 24 * 60 * 60, token);

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
    res.status(500).json({ error: error.message || 'Internal server error' });
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
    res.status(500).json({ error: error.message || 'Failed to update country' });
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
    res.status(500).json({ error: error.message || 'Failed to update photo' });
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
    res.status(500).json({ error: error.message || 'Failed to update username' });
  }
});

router.get('/contacts', authMiddleware, async (req, res) => {
  try {
    const cacheKey = `contacts:${req.user.id}`;
    const cachedContacts = await redis.get(cacheKey);
    if (cachedContacts) return res.json(JSON.parse(cachedContacts));

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

    await redis.setex(cacheKey, 300, JSON.stringify(contacts));
    res.json(contacts);
  } catch (error) {
    logger.error('Fetch contacts error', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: error.message || 'Failed to fetch contacts' });
  }
});

router.get('/public_key/:userId', authMiddleware, async (req, res) => {
  try {
    const cacheKey = `publicKey:${req.params.userId}`;
    const cachedKey = await redis.get(cacheKey);
    if (cachedKey) return res.json({ publicKey: cachedKey });

    const user = await User.findById(req.params.userId).select('publicKey');
    if (!user) return res.status(404).json({ error: 'User not found' });

    await redis.setex(cacheKey, 3600, user.publicKey);
    res.json({ publicKey: user.publicKey });
  } catch (error) {
    logger.error('Fetch public key error:', { error: error.message, userId: req.params.userId });
    res.status(500).json({ error: error.message || 'Failed to fetch public key' });
  }
});

router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId && userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const user = await User.findById(req.user.id).select('+privateKey');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newToken = jwt.sign(
      { id: user._id, email: user.email, virtualNumber: user.virtualNumber, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    await redis.setex(`token:${user._id}`, 24 * 60 * 60, newToken);
    await redis.del(`session:${req.headers.authorization.split(' ')[1]}`); // Clear old session

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

router.post('/add_contact', authMiddleware, async (req, res) => {
  try {
    const addContactSchema = Joi.object({
      userId: Joi.string().required(),
      virtualNumber: Joi.string().required(),
    });
    const { error } = addContactSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { userId, virtualNumber } = req.body;
    if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const contact = await User.findOne({ virtualNumber });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (user.contacts.includes(contact._id)) return res.status(400).json({ error: 'Contact already added' });

    user.contacts.push(contact._id);
    await user.save();

    const contactData = {
      id: contact._id,
      username: contact.username,
      virtualNumber: contact.virtualNumber,
      photo: contact.photo || 'https://placehold.co/40x40',
      status: contact.status,
      lastSeen: contact.lastSeen,
    };

    await redis.del(`contacts:${userId}`); // Invalidate cache
    logger.info('Contact added', { userId, contactId: contact._id });
    res.json(contactData);
  } catch (error) {
    logger.error('Add contact error:', { error: error.message, userId: req.body.userId });
    res.status(500).json({ error: error.message || 'Failed to add contact' });
  }
});

module.exports = { router, authMiddleware };