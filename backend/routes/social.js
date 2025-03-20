const express = require('express');
const multer = require('multer');
const Post = require('../models/Post');
const router = express.Router();

const upload = multer({ dest: 'uploads/' });

router.get('/feed', async (req, res) => {
  const posts = await Post.find({ expiresAt: { $exists: false } }).populate('userId', 'email');
  res.json(posts);
});

router.post('/post', upload.single('content'), async (req, res) => {
  const { userId, contentType } = req.body;
  const content = req.file ? `/uploads/${req.file.filename}` : req.body.content;
  const post = new Post({ userId, contentType, content });
  await post.save();
  res.json(post);
});

router.post('/story', upload.single('content'), async (req, res) => {
  const { userId, contentType } = req.body;
  const content = req.file ? `/uploads/${req.file.filename}` : req.body.content;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const story = new Post({ userId, contentType, content, expiresAt });
  await story.save();
  res.json(story);
});

module.exports = router;