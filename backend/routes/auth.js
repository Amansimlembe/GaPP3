const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const authMiddleware = require('../middleware/auth');
const { getCountries, generateNumber } = require('libphonenumber-js');

const upload = multer({ storage: multer.memoryStorage() });

// Helper function to generate a virtual phone number
const generateVirtualNumber = (countryCode) => {
  const countryData = getCountries().find(c => c === countryCode);
  if (!countryData) throw new Error('Invalid country code');
  
  // Generate a random number based on typical length for the country
  const exampleNumber = generateNumber(countryCode);
  const numberLength = exampleNumber.replace(/[^0-9]/g, '').length - countryCode.length;
  const randomNum = Math.floor(Math.random() * Math.pow(10, numberLength)).toString().padStart(numberLength, '0');
  return `+${countryCode}${randomNum}`;
};

router.post('/register', upload.single('photo'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    let photoUrl = '';
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'image', folder: 'gapp_photos' },
          (error, result) => error ? reject(error) : resolve(result)
        ).end(req.file.buffer);
      });
      photoUrl = result.secure_url;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashedPassword, role: parseInt(role), photo: photoUrl });
    await user.save();

    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.json({ token, userId: user._id, role: user.role, photo: user.photo });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.json({ token, userId: user._id, role: user.role, photo: user.photo, virtualNumber: user.virtualNumber, username: user.username });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed', details: error.message });
  }
});

router.post('/update_photo', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'image', folder: 'gapp_photos' },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(req.file.buffer);
    });
    const user = await User.findByIdAndUpdate(userId, { photo: result.secure_url }, { new: true });
    res.json({ photo: user.photo });
  } catch (error) {
    console.error('Photo update error:', error);
    res.status(500).json({ error: 'Failed to update photo', details: error.message });
  }
});

router.post('/update_username', authMiddleware, async (req, res) => {
  try {
    const { userId, username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username is required' });
    const existingUser = await User.findOne({ username });
    if (existingUser && existingUser._id.toString() !== userId) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    const user = await User.findByIdAndUpdate(userId, { username }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ username: user.username });
  } catch (error) {
    console.error('Username update error:', error);
    res.status(500).json({ error: 'Failed to update username', details: error.message });
  }
});

router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ username: user.username, photo: user.photo, country: user.country, virtualNumber: user.virtualNumber });
  } catch (error) {
    console.error('Fetch user error:', error);
    res.status(500).json({ error: 'Failed to fetch user', details: error.message });
  }
});

router.post('/update_country', authMiddleware, async (req, res) => {
  try {
    const { userId, country } = req.body;
    if (!country || !getCountries().includes(country)) return res.status(400).json({ error: 'Invalid country code' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    user.country = country;
    if (!user.virtualNumber) {
      user.virtualNumber = generateVirtualNumber(country);
    }
    await user.save();
    res.json({ virtualNumber: user.virtualNumber, country: user.country });
  } catch (error) {
    console.error('Update country error:', error);
    res.status(500).json({ error: 'Failed to update country', details: error.message });
  }
});

router.post('/add_contact', authMiddleware, async (req, res) => {
  try {
    const { userId, virtualNumber } = req.body;
    const contact = await User.findOne({ virtualNumber });
    if (!contact) return res.status(404).json({ error: 'User not found' });
    const user = await User.findById(userId);
    if (!user.contacts) user.contacts = [];
    if (!user.contacts.includes(contact._id)) user.contacts.push(contact._id);
    await user.save();
    res.json({ userId: contact._id, virtualNumber: contact.virtualNumber, username: contact.username, photo: contact.photo });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Failed to add contact', details: error.message });
  }
});

router.get('/contacts', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).populate('contacts', 'virtualNumber username photo');
    res.json(user.contacts.map(c => ({ id: c._id, virtualNumber: c.virtualNumber, username: c.username, photo: c.photo })));
  } catch (error) {
    console.error('Fetch contacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts', details: error.message });
  }
});

module.exports = router;                              