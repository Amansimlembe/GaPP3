const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const authMiddleware = require('../middleware/auth'); // Add this import

const upload = multer({ storage: multer.memoryStorage() });

router.post('/register', upload.single('photo'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    let photoUrl = '';
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'image', folder: 'gapp_photos' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        ).end(req.file.buffer);
      });
      photoUrl = result.secure_url;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashedPassword, role: parseInt(role), photo: photoUrl });
    await user.save();

    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
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
    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, userId: user._id, role: user.role, photo: user.photo });
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
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
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

module.exports = router;