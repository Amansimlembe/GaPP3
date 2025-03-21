const express = require('express');
const router = express.Router();
const Post = require('../models/Post');

router.get('/feed', async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    res.json(posts);
  } catch (error) {
    console.error('Feed error:', error);
    res.status(500).json({ error: 'Failed to load feed' });
  }
});

router.post('/post', async (req, res) => {
  const { userId, contentType, content } = req.body;
  const post = new Post({ userId, contentType, content, createdAt: new Date() });
  await post.save();
  res.json(post);
});

router.get('/stories', async (req, res) => {
  const stories = await Post.find({ isStory: true, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
  res.json(stories);
});

router.post('/story', async (req, res) => {
  const { userId, contentType, content } = req.body;
  const story = new Post({ userId, contentType, content, isStory: true, createdAt: new Date() });
  await story.save();
  res.json(story);
});

module.exports = router;