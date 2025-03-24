const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const auth = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');

router.post('/register', upload.single('photo'), async (req, res) => {
  const { email, password, name, role, country } = req.body;
  const photo = req.file;

  try {
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ error: 'User already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const virtualNumber = `${getCountryCallingCode(country)}${Math.floor(100000000 + Math.random() * 900000000)}`;

    user = new User({
      email,
      password: hashedPassword,
      username: name,
      role,
      country,
      virtualNumber,
      photo: photo ? `/uploads/${photo.filename}` : null,
    });

    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
    res.json({ token, userId: user._id, role: user.role, photo: user.photo, virtualNumber: user.virtualNumber });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
    res.json({ token, userId: user._id, role: user.role, photo: user.photo, virtualNumber: user.virtualNumber });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
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

router.get('/user/:id', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});



router.post('/add_contact', auth, async (req, res) => {
  const { userId, virtualNumber } = req.body;
  try {
    const contact = await User.findOne({ virtualNumber });
    if (!contact) return res.status(404).json({ error: 'User not found' });
    const user = await User.findById(userId);
    if (!user.contacts.includes(contact._id)) {
      user.contacts.push(contact._id);
      await user.save();
    }
    res.json({ userId: contact._id, virtualNumber: contact.virtualNumber, username: contact.username, photo: contact.photo });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Server error' });
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