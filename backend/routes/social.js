const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const Message = require('../models/Message');
const User = require('../models/User');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const authMiddleware = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

// Fetch all posts for the feed
router.get('/feed', async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    res.json(posts);
  } catch (error) {
    console.error('Feed fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch feed', details: error.message });
  }
});

// Create a new post
router.post('/post', authMiddleware, upload.single('content'), async (req, res) => {
  try {
    const { userId } = req.user;
    const { contentType, caption } = req.body;
    if (!contentType) return res.status(400).json({ error: 'Content type is required' });

    let contentUrl = caption || '';
    if (req.file) {
      const resourceType = ['image', 'video', 'audio', 'raw'].includes(contentType) ? contentType : 'raw';
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: resourceType, public_id: `${contentType}_${userId}_${Date.now()}`, folder: `gapp_${contentType}s` },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        ).end(req.file.buffer);
      });
      contentUrl = result.secure_url;
      console.log('Post media URL:', contentUrl);
    }

    const user = await User.findById(userId);
    const post = new Post({
      userId,
      contentType,
      content: contentUrl,
      caption,
      username: user.username,
      photo: user.photo,
    });
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Post error:', { message: error.message, stack: error.stack, body: req.body, file: !!req.file });
    res.status(500).json({ error: 'Failed to post', details: error.message });
  }
});

// Create a new story (similar to post but with expiration)
router.post('/story', authMiddleware, upload.single('content'), async (req, res) => {
  try {
    const { userId } = req.user;
    const { contentType, caption } = req.body;
    if (!contentType) return res.status(400).json({ error: 'Content type is required' });

    let contentUrl = caption || '';
    if (req.file) {
      const resourceType = ['image', 'video', 'audio', 'raw'].includes(contentType) ? contentType : 'raw';
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: resourceType, public_id: `${contentType}_${userId}_${Date.now()}`, folder: `gapp_${contentType}s` },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        ).end(req.file.buffer);
      });
      contentUrl = result.secure_url;
      console.log('Story media URL:', contentUrl);
    }

    const user = await User.findById(userId);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours expiration
    const story = new Post({
      userId,
      contentType,
      content: contentUrl,
      caption,
      username: user.username,
      photo: user.photo,
      isStory: true,
      expiresAt,
    });
    await story.save();
    res.json(story);
  } catch (error) {
    console.error('Story error:', { message: error.message, stack: error.stack, body: req.body, file: !!req.file });
    res.status(500).json({ error: 'Failed to post story', details: error.message });
  }
});

// Fetch messages between two users
router.get('/messages', authMiddleware, async (req, res) => {
  try {
    const { userId, recipientId } = req.query;
    if (!userId || !recipientId) return res.status(400).json({ error: 'User ID and recipient ID are required' });
    const messages = await Message.find({
      $or: [
        { senderId: userId, recipientId },
        { senderId: recipientId, recipientId: userId },
      ],
    }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (error) {
    console.error('Fetch messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
  }
});

// Send a new message
router.post('/message', authMiddleware, upload.single('content'), async (req, res) => {
  try {
    const { senderId, recipientId, contentType, caption } = req.body;
    if (!senderId || !recipientId || !contentType) {
      return res.status(400).json({ error: 'Sender ID, recipient ID, and content type are required' });
    }

    let contentUrl = req.body.content || '';
    if (req.file) {
      const resourceType = ['image', 'video', 'audio', 'raw'].includes(contentType) ? contentType : 'raw';
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: resourceType, public_id: `${contentType}_${senderId}_${Date.now()}`, folder: `gapp_chat_${contentType}s` },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        ).end(req.file.buffer);
      });
      contentUrl = result.secure_url;
      console.log('Message media URL:', contentUrl);
    }

    const message = new Message({ senderId, recipientId, contentType, content: contentUrl, caption });
    await message.save();
    res.json(message);
  } catch (error) {
    console.error('Message error:', { message: error.message, stack: error.stack, body: req.body, file: !!req.file });
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

// Like a post
router.post('/like', authMiddleware, async (req, res) => {
  try {
    const { postId } = req.body;
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    post.likes = (post.likes || 0) + 1;
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Like error:', error);
    res.status(500).json({ error: 'Failed to like post', details: error.message });
  }
});

// Comment on a post
router.post('/comment', authMiddleware, async (req, res) => {
  try {
    const { postId, comment } = req.body;
    const { userId } = req.user;
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const commentData = { userId, comment, createdAt: new Date() };
    post.comments = [...(post.comments || []), commentData];
    await post.save();
    res.json(commentData);
  } catch (error) {
    console.error('Comment error:', error);
    res.status(500).json({ error: 'Failed to comment', details: error.message });
  }
});

module.exports = router;