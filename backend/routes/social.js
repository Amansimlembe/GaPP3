const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

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

    let contentUrl = caption;
    if (req.file) {
      const resourceType = contentType === 'text' ? 'raw' : contentType;
      const result = await cloudinary.uploader.upload_stream(
        { resource_type: resourceType, public_id: `${contentType}_${userId}_${Date.now()}`, folder: `gapp_${contentType}s` },
        (error, result) => {
          if (error) throw error;
          return result;
        }
      ).end(req.file.buffer);
      contentUrl = result.secure_url;
    }

    const post = new Post({ userId, contentType, content: contentUrl });
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

    let contentUrl = caption;
    if (req.file) {
      const resourceType = contentType === 'text' ? 'raw' : contentType;
      const result = await cloudinary.uploader.upload_stream(
        { resource_type: resourceType, public_id: `${contentType}_${userId}_${Date.now()}`, folder: `gapp_${contentType}s` },
        (error, result) => {
          if (error) throw error;
          return result;
        }
      ).end(req.file.buffer);
      contentUrl = result.secure_url;
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const post = new Post({ userId, contentType, content: contentUrl, isStory: true, expiresAt });
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Story error:', error);
    res.status(500).json({ error: 'Failed to post story' });
  }
});

module.exports = router;