const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const router = express.Router();
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

router.post('/register', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password must be strings' });
    }

    // Check for existing user
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    if (!hashedPassword) {
      throw new Error('Failed to hash password');
    }

    // Create user
    const user = new User({ email, password: hashedPassword, role: role || 0 });
    await user.save();

    // Generate JWT
    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
    if (!token) {
      throw new Error('Failed to generate JWT');
    }

    res.status(201).json({ token, userId: user._id, role: user.role, message: 'User registered successfully' });
  } catch (error) {
    console.error('Registration error:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
    });
    res.status(500).json({ error: 'Server error during registration', details: error.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password must be strings' });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT
    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
    if (!token) {
      throw new Error('Failed to generate JWT');
    }

    res.json({ token, userId: user._id, role: user.role, photo: user.photo || '', message: 'Login successful' });
  } catch (error) {
    console.error('Login error:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
    });
    res.status(500).json({ error: 'Server error during login', details: error.message });
  }
});

router.post('/update_photo', upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || !req.file) return res.status(400).json({ error: 'User ID and photo are required' });

    const result = await cloudinary.uploader.upload_stream(
      { resource_type: 'image', public_id: `photo_${userId}`, folder: 'gapp_photos' },
      (error, result) => {
        if (error) throw error;
        return result;
      }
    ).end(req.file.buffer);

    const user = await User.findByIdAndUpdate(userId, { photo: result.secure_url }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ photo: user.photo });
  } catch (error) {
    console.error('Photo upload error:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

module.exports = router;