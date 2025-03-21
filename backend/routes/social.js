const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const multer = require('multer');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// Get feed
router.get('/feed', async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

// Post content
router.post('/post', upload.single('content'), async (req, res) => {
  try {
    const { userId, contentType, caption } = req.body;
    const content = contentType === 'text' ? caption : `/uploads/${req.file.filename}`;
    const post = new Post({ userId, contentType, content });
    await post.save();
    res.json(post);
  } catch (error) {
    res.status(500).json({ error: 'Failed to post' });
  }
});

// Post story (24-hour expiration)
router.post('/story', upload.single('content'), async (req, res) => {
  try {
    const { userId, contentType, caption } = req.body;
    const content = contentType === 'text' ? caption : `/uploads/${req.file.filename}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const post = new Post({ userId, contentType, content, isStory: true, expiresAt });
    await post.save();
    res.json(post);
  } catch (error) {
    res.status(500).json({ error: 'Failed to post story' });
  }
});

module.exports = router;