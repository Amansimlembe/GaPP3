const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const bcrypt = require('bcryptjs');

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

// Register a new user
router.post('/register', async (req, res) => {
  try {
    const { email, password, username, country } = req.body;
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, password, and username are required' });
    }

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    // Generate ECDH key pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'secp256k1',
    });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

    // Generate virtual number (simplified unique identifier)
    const virtualNumber = `+${Math.floor(1000000000 + Math.random() * 9000000000)}`;

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      email,
      password: hashedPassword,
      username,
      country,
      virtualNumber,
      publicKey: publicKeyPem,
      privateKey: privateKeyPem, // Store securely (consider encryption in production)
      status: 'offline',
      lastSeen: null,
    });
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
      photo: user.photo || 'https://placehold.co/40x40',
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
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login', details: error.message });
  }
});

// Get user's contacts
router.get('/contacts', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('contacts', 'username virtualNumber photo status lastSeen');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user.contacts);
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

module.exports = router;