const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { getCountryCallingCode, parsePhoneNumberFromString } = require('libphonenumber-js');
const User = require('../models/User');

// Configure Multer for file uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// Configure Cloudinary (assumed set via environment variables in server.js)
if (!cloudinary.config().cloud_name) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// JWT Authentication Middleware
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log('Auth Header:', authHeader);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error('No token provided or malformed header:', authHeader);
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  console.log('Extracted Token:', token);

  if (!token) {
    console.error('Token missing after Bearer');
    return res.status(401).json({ error: 'Token missing' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret', {
      algorithms: ['HS256'],
    });
    console.log('Decoded Token:', decoded);
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(401).json({ error: 'Invalid token', details: error.message });
  }
};

// Generate virtual number based on country and userId
const generateVirtualNumber = (countryCode, userId) => {
  const hash = crypto.createHash('sha256').update(userId).digest('hex');
  const numericPart = parseInt(hash.substring(0, 8), 16).toString().padStart(9, '0').slice(0, 9); // 9 digits
  const countryCallingCode = getCountryCallingCode(countryCode);
  const rawNumber = `+${countryCallingCode}${numericPart}`;
  const phoneNumber = parsePhoneNumberFromString(rawNumber, countryCode);
  return phoneNumber ? phoneNumber.formatInternational() : rawNumber;
};

// Register a new user
router.post('/register', upload.single('photo'), async (req, res) => {
  try {
    const { email, password, username, country } = req.body;
    if (!email || !password || !username || !country) {
      return res.status(400).json({ error: 'Email, password, username, and country are required' });
    }

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'secp256k1',
    });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const virtualNumber = generateVirtualNumber(country, crypto.randomBytes(16).toString('hex')); // Unique temp ID
    const user = new User({
      email,
      password: hashedPassword,
      username,
      country,
      virtualNumber,
      publicKey: publicKeyPem,
      privateKey: privateKeyPem,
      role: req.body.role || 0,
      status: 'offline',
      lastSeen: null,
      photo: 'https://placehold.co/40x40', // Default photo
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

    const token = jwt.sign(
      { id: user._id, email: user.email, virtualNumber: user.virtualNumber },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '1h' }
    );

    res.status(201).json({
      token,
      userId: user._id,
      virtualNumber: user.virtualNumber,
      username: user.username,
      photo: user.photo,
      role: user.role,
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Failed to register', details: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, virtualNumber: user.virtualNumber },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '1h' }
    );

    user.status = 'online';
    user.lastSeen = new Date();
    await user.save();

    res.json({
      token,
      userId: user._id,
      virtualNumber: user.virtualNumber,
      username: user.username,
      photo: user.photo || 'https://placehold.co/40x40',
      role: user.role,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login', details: error.message });
  }
});

// Update country
router.post('/update_country', authMiddleware, async (req, res) => {
  try {
    const { userId, country } = req.body;
    if (userId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!country) {
      return res.status(400).json({ error: 'Country is required' });
    }

    // Only regenerate virtualNumber if it hasn’t been set or country changes
    if (!user.virtualNumber || user.country !== country) {
      user.country = country;
      user.virtualNumber = generateVirtualNumber(country, user._id.toString());
      await user.save();
    }

    res.json({ virtualNumber: user.virtualNumber });
  } catch (error) {
    console.error('Update country error:', error);
    res.status(500).json({ error: 'Failed to update country', details: error.message });
  }
});

// Update profile photo
router.post('/update_photo', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!req.file) {
      return res.status(400).json({ error: 'No photo provided' });
    }

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'image', folder: 'gapp_profile_photos' },
        (error, result) => (error ? reject(error) : resolve(result))
      ).end(req.file.buffer);
    });

    user.photo = result.secure_url;
    await user.save();
    res.json({ photo: user.photo });
  } catch (error) {
    console.error('Update photo error:', error);
    res.status(500).json({ error: 'Failed to update photo', details: error.message });
  }
});

// Update username
router.post('/update_username', authMiddleware, async (req, res) => {
  try {
    const { userId, username } = req.body;
    if (userId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!username.trim()) {
      return res.status(400).json({ error: 'Username cannot be empty' });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser && existingUser._id.toString() !== userId) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    user.username = username;
    await user.save();
    res.json({ username: user.username });
  } catch (error) {
    console.error('Update username error:', error);
    res.status(500).json({ error: 'Failed to update username', details: error.message });
  }
});

// Get user's contacts
router.get('/contacts', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('contacts', 'username virtualNumber photo status lastSeen');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Ensure all contacts have required fields
    const contacts = user.contacts.map((contact) => ({
      id: contact._id,
      username: contact.username,
      virtualNumber: contact.virtualNumber,
      photo: contact.photo || 'https://placehold.co/40x40',
      status: contact.status || 'offline',
      lastSeen: contact.lastSeen,
    }));

    res.json(contacts);
  } catch (error) {
    console.error('Fetch contacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts', details: error.message });
  }
});

// Add a contact
router.post('/add_contact', authMiddleware, async (req, res) => {
  try {
    const { userId, virtualNumber } = req.body;
    if (userId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (!virtualNumber) {
      return res.status(400).json({ error: 'Virtual number is required' });
    }

    const contact = await User.findOne({ virtualNumber });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact._id.toString() === userId) return res.status(400).json({ error: 'Cannot add yourself as a contact' });

    const user = await User.findById(userId);
    if (!user.contacts.includes(contact._id)) {
      user.contacts.push(contact._id);
      await user.save();

      // Generate shared key using ECDH
      const userPrivateKey = crypto.createPrivateKey(user.privateKey);
      const contactPublicKey = crypto.createPublicKey(contact.publicKey);
      const sharedKey = crypto.diffieHellman({
        privateKey: userPrivateKey,
        publicKey: contactPublicKey,
      });
      const sharedKeyBase64 = sharedKey.toString('base64');

      user.sharedKeys.push({ contactId: contact._id, key: sharedKeyBase64 });
      await user.save();

      // Add reciprocal contact and shared key
      const contactPrivateKey = crypto.createPrivateKey(contact.privateKey);
      const userPublicKey = crypto.createPublicKey(user.publicKey);
      const contactSharedKey = crypto.diffieHellman({
        privateKey: contactPrivateKey,
        publicKey: userPublicKey,
      });
      contact.sharedKeys.push({ contactId: user._id, key: contactSharedKey.toString('base64') });
      await contact.save();
    }

    res.json({
      userId: contact._id,
      virtualNumber: contact.virtualNumber,
      username: contact.username,
      photo: contact.photo || 'https://placehold.co/40x40',
    });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Failed to add contact', details: error.message });
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
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found', code: 'RECIPIENT_NOT_FOUND' });
    }

    if (!user.contacts.includes(recipientId)) {
      return res.status(403).json({ error: 'Recipient is not a contact' });
    }

    const sharedKeyEntry = user.sharedKeys.find((entry) => entry.contactId.toString() === recipientId);
    if (!sharedKeyEntry) {
      return res.status(404).json({ error: 'No shared key found', code: 'NO_SHARED_KEY' });
    }

    res.json({ sharedKey: sharedKeyEntry.key });
  } catch (error) {
    console.error('Fetch shared key error:', error);
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
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '1h' }
    );

    res.json({
      token: newToken,
      userId: user._id,
      role: user.role,
      photo: user.photo || 'https://placehold.co/40x40',
      virtualNumber: user.virtualNumber,
      username: user.username,
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ error: 'Failed to refresh token', details: error.message });
  }
});

module.exports = router;