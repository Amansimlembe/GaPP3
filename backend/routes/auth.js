// auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { getCountryCallingCode, parsePhoneNumberFromString } = require('libphonenumber-js');
const Joi = require('joi');
const winston = require('winston');
const User = require('../models/User');

const router = express.Router();

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Multer configuration
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

// JWT Authentication Middleware
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  logger.info('Auth Header:', { authHeader });

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.error('No token provided or malformed header', { authHeader });
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  logger.info('Extracted Token:', { token });

  if (!token) {
    logger.error('Token missing after Bearer');
    return res.status(401).json({ error: 'Token missing' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    logger.info('Decoded Token:', { decoded });
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', { error: error.message });
    return res.status(401).json({ error: 'Invalid token', details: error.message });
  }
};

// Validation schemas
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

const addContactSchema = Joi.object({
  userId: Joi.string().required(),
  virtualNumber: Joi.string().pattern(/^\+\d{10,15}$/).required(),
});

// Generate virtual number
const generateVirtualNumber = (countryCode, userId) => {
  if (!countryCode || typeof countryCode !== 'string') throw new Error('Invalid country code');
  const hash = crypto.createHash('sha256').update(userId).digest('hex');
  const numericPart = parseInt(hash.substring(0, 8), 16).toString().padStart(9, '0').slice(0, 9);
  const countryCallingCode = getCountryCallingCode(countryCode.toUpperCase());
  const rawNumber = `+${countryCallingCode}${numericPart}`;
  const phoneNumber = parsePhoneNumberFromString(rawNumber, countryCode.toUpperCase());
  return phoneNumber ? phoneNumber.formatInternational() : rawNumber;
};

// Register a new user
router.post('/register', upload.single('photo'), async (req, res) => {
  try {
    logger.info('Register request received', { body: req.body, file: !!req.file });
    const { error } = registerSchema.validate(req.body);
    if (error) {
      logger.warn('Validation failed', { error: error.details[0].message });
      return res.status(400).json({ error: error.details[0].message });
    }

    const { email, password, username, country, role } = req.body;
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      logger.warn('Duplicate email or username', { email, username });
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    const { publicKey, privateKey } = await new Promise((resolve, reject) => {
      crypto.generateKeyPair('ec', { namedCurve: 'secp256k1' }, (err, pub, priv) => {
        if (err) reject(err);
        else resolve({ publicKey: pub, privateKey: priv });
      });
    });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const virtualNumber = generateVirtualNumber(country, crypto.randomBytes(16).toString('hex'));

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
      } catch (uploadError) {
        logger.error('Photo upload error:', { error: uploadError.message, stack: uploadError.stack });
        return res.status(500).json({ error: 'Failed to upload photo', details: uploadError.message });
      }
    }

    await user.save();
    const token = jwt.sign({ id: user._id, email, virtualNumber, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });

    logger.info('User registered', { userId: user._id, email, role: user.role });
    res.status(201).json({ token, userId: user._id, virtualNumber, username, photo: user.photo, role: user.role });
  } catch (error) {
    logger.error('Register error:', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to register', details: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    logger.info('Login request received', { body: req.body });
    const { error } = loginSchema.validate(req.body);
    if (error) {
      logger.warn('Validation failed', { error: error.details[0].message });
      return res.status(400).json({ error: error.details[0].message });
    }

    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      logger.warn('Invalid login attempt', { email });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id, email, virtualNumber: user.virtualNumber, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });

    user.status = 'online';
    user.lastSeen = new Date();
    await user.save();

    logger.info('User logged in', { userId: user._id, email, role: user.role });
    res.json({
      token,
      userId: user._id,
      virtualNumber: user.virtualNumber,
      username: user.username,
      photo: user.photo || 'https://placehold.co/40x40',
      role: user.role,
    });
  } catch (error) {
    logger.error('Login error:', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to login', details: error.message });
  }
});

// Updated /add_contact endpoint
router.post('/add_contact', authMiddleware, async (req, res) => {
  try {
    const { error } = addContactSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { userId, virtualNumber } = req.body;
    logger.info('Adding contact', { userId, virtualNumber });

    if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const contact = await User.findOne({ virtualNumber });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact._id.toString() === userId) return res.status(400).json({ error: 'Cannot add yourself as a contact' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Validate cryptographic keys
    for (const [keyName, keyValue] of [
      ['user.privateKey', user.privateKey],
      ['user.publicKey', user.publicKey],
      ['contact.privateKey', contact.privateKey],
      ['contact.publicKey', contact.publicKey],
    ]) {
      if (!keyValue || typeof keyValue !== 'string' || !keyValue.startsWith('-----BEGIN')) {
        logger.error('Invalid key detected', { userId, contactId: contact._id, keyName });
        return res.status(500).json({ error: `Invalid ${keyName} format` });
      }
    }

    if (!user.contacts.includes(contact._id)) {
      user.contacts = user.contacts || [];
      user.sharedKeys = user.sharedKeys || [];
      contact.sharedKeys = contact.sharedKeys || [];

      const userPrivateKey = crypto.createPrivateKey(user.privateKey);
      const contactPublicKey = crypto.createPublicKey(contact.publicKey);
      const sharedKey = crypto.diffieHellman({
        privateKey: userPrivateKey,
        publicKey: contactPublicKey,
      });
      const sharedKeyBase64 = sharedKey.toString('base64');
      user.sharedKeys.push({ contactId: contact._id, key: sharedKeyBase64 });

      const contactPrivateKey = crypto.createPrivateKey(contact.privateKey);
      const userPublicKey = crypto.createPublicKey(user.publicKey);
      const contactSharedKey = crypto.diffieHellman({
        privateKey: contactPrivateKey,
        publicKey: userPublicKey,
      });
      contact.sharedKeys.push({ contactId: user._id, key: contactSharedKey.toString('base64') });

      await Promise.all([user.save(), contact.save()]);
    }

    logger.info('Contact added', { userId, contactId: contact._id });
    res.json({
      userId: contact._id,
      virtualNumber: contact.virtualNumber,
      username: contact.username,
      photo: contact.photo || 'https://placehold.co/40x40',
    });
  } catch (error) {
    logger.error('Add contact error:', { error: error.message, stack: error.stack, body: req.body });
    res.status(500).json({ error: 'Failed to add contact', details: error.message });
  }
});

// Update country
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
      user.virtualNumber = generateVirtualNumber(country, user._id.toString());
      await user.save();
    }

    logger.info('Country updated', { userId, country });
    res.json({ virtualNumber: user.virtualNumber });
  } catch (error) {
    logger.error('Update country error:', { error: error.message });
    res.status(500).json({ error: 'Failed to update country', details: error.message });
  }
});

// Update profile photo
router.post('/update_photo', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!req.file) return res.status(400).json({ error: 'No photo provided' });

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
    logger.error('Update photo error:', { error: error.message });
    res.status(500).json({ error: 'Failed to update photo', details: error.message });
  }
});

// Update username
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
    if (existingUser && existingUser._id.toString() !== userId) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    user.username = username.trim();
    await user.save();

    logger.info('Username updated', { userId, username });
    res.json({ username: user.username });
  } catch (error) {
    logger.error('Update username error:', { error: error.message });
    res.status(500).json({ error: 'Failed to update username', details: error.message });
  }
});

// Get user's contacts
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

    logger.info('Contacts fetched', { userId: req.user.id });
    res.json(contacts);
  } catch (error) {
    logger.error('Fetch contacts error:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch contacts', details: error.message });
  }
});

// Get shared key for a contact
router.get('/shared_key/:recipientId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const recipientId = req.params.recipientId;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const recipient = await User.findById(recipientId);
    if (!recipient) return res.status(404).json({ error: 'Recipient not found', code: 'RECIPIENT_NOT_FOUND' });

    if (!user.contacts.includes(recipientId)) return res.status(403).json({ error: 'Recipient is not a contact' });

    const sharedKeyEntry = user.sharedKeys.find((entry) => entry.contactId.toString() === recipientId);
    if (!sharedKeyEntry) return res.status(404).json({ error: 'No shared key found', code: 'NO_SHARED_KEY' });

    logger.info('Shared key fetched', { userId, recipientId });
    res.json({ sharedKey: sharedKeyEntry.key });
  } catch (error) {
    logger.error('Fetch shared key error:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch shared key', details: error.message });
  }
});

// Refresh token
router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newToken = jwt.sign(
      { id: user._id, email: user.email, virtualNumber: user.virtualNumber },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info('Token refreshed', { userId: user._id });
    res.json({
      token: newToken,
      userId: user._id,
      role: user.role,
      photo: user.photo || 'https://placehold.co/40x40',
      virtualNumber: user.virtualNumber,
      username: user.username,
    });
  } catch (error) {
    logger.error('Refresh token error:', { error: error.message });
    res.status(500).json({ error: 'Failed to refresh token', details: error.message });
  }
});

module.exports = { router, authMiddleware };