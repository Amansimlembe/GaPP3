const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const multer = require('multer');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

router.get('/feed', async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    res.json(posts);
  } catch (error) {
    console.error('Feed fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

router.post('/post', upload.single('content'), async (req, res) => {
  try {
    const { userId, contentType, caption } = req.body;
    if (!userId || !contentType) return res.status(400).json({ error: 'User ID and content type are required' });
    const content = contentType === 'text' ? caption : req.file ? `/uploads/${req.file.filename}` : null;
    if (!content) return res.status(400).json({ error: 'Content is required' });
    const post = new Post({ userId, contentType, content });
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Post error:', error);
    res.status(500).json({ error: 'Failed to post' });
  }
});

router.post('/story', upload.single('content'), async (req, res) => {
  try {
    const { userId, contentType, caption } = req.body;
    if (!userId || !contentType) return res.status(400).json({ error: 'User ID and content type are required' });
    const content = contentType === 'text' ? caption : req.file ? `/uploads/${req.file.filename}` : null;
    if (!content) return res.status(400).json({ error: 'Content is required' });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const post = new Post({ userId, contentType, content, isStory: true, expiresAt });
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Story error:', error);
    res.status(500).json({ error: 'Failed to post story' });
  }
});

module.exports = router;