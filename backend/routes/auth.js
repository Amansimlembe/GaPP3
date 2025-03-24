const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const auth = require('../middleware/auth');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { getCountryCallingCode } = require('libphonenumber-js');
const countryList = require('country-list');

// Cloudinary configuration
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/register', upload.single('photo'), async (req, res) => {
  const { email, password, name, role, country } = req.body;
  const photo = req.file;

  try {
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ error: 'User already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const countryCode = countryList.getCode(country) || country;
    if (!countryCode) return res.status(400).json({ error: 'Invalid country' });

    const callingCode = getCountryCallingCode(countryCode);
    const virtualNumber = `${callingCode}${Math.floor(100000000 + Math.random() * 900000000)}`;

    let photoUrl = null;
    if (photo) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'image', folder: 'gapp_photos' },
          (error, result) => (error ? reject(error) : resolve(result))
        ).end(photo.buffer);
      });
      photoUrl = result.secure_url;
    }

    user = new User({
      email,
      password: hashedPassword,
      username: name,
      role,
      country,
      virtualNumber,
      photo: photoUrl,
    });

    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '30d' });
    res.json({ token, userId: user._id, role: user.role, photo: user.photo, virtualNumber: user.virtualNumber });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '30d' });
    res.json({ token, userId: user._id, role: user.role, photo: user.photo, virtualNumber: user.virtualNumber });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/refresh', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '30d' });
    res.json({ token: newToken, userId: user._id, role: user.role, photo: user.photo, virtualNumber: user.virtualNumber });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ error: 'Failed to refresh token', details: error.message });
  }
});

router.post('/update_photo', auth, upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'image', folder: 'gapp_photos' },
        (error, result) => (error ? reject(error) : resolve(result))
      ).end(req.file.buffer);
    });

    const user = await User.findByIdAndUpdate(userId, { photo: result.secure_url }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ photo: user.photo });
  } catch (error) {
    console.error('Photo update error:', error);
    res.status(500).json({ error: 'Failed to update photo', details: error.message });
  }
});

router.post('/update_username', auth, async (req, res) => {
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

router.post('/update_country', auth, async (req, res) => {
  try {
    const { userId, country } = req.body;
    if (!country) return res.status(400).json({ error: 'Country is required' });

    const countryCode = countryList.getCode(country) || country;
    if (!countryCode) return res.status(400).json({ error: 'Invalid country' });

    const callingCode = getCountryCallingCode(countryCode);
    const virtualNumber = `${callingCode}${Math.floor(100000000 + Math.random() * 900000000)}`;

    const user = await User.findByIdAndUpdate(
      userId,
      { country: countryCode, virtualNumber },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ virtualNumber: user.virtualNumber });
  } catch (error) {
    console.error('Update country error:', error);
    res.status(500).json({ error: 'Failed to update country', details: error.message });
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

router.get('/contacts', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('contacts', 'virtualNumber username photo');
    res.json(user.contacts.map(c => ({ id: c._id, virtualNumber: c.virtualNumber, username: c.username, photo: c.photo })));
  } catch (error) {
    console.error('Fetch contacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts', details: error.message });
  }
});

module.exports = router;