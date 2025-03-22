const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const Message = require('../models/Message');
const User = require('../models/User');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const authMiddleware = require('../middleware/auth');
const cache = require('memory-cache');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Define cacheMiddleware before using it
const cacheMiddleware = (duration) => (req, res, next) => {
  const key = '__express__' + req.originalUrl || req.url;
  const cachedBody = cache.get(key);
  if (cachedBody) return res.send(cachedBody);
  res.sendResponse = res.send;
  res.send = (body) => {
    cache.put(key, body, duration * 1000);
    res.sendResponse(body);
  };
  next();
};

router.get('/feed', cacheMiddleware(60), async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    res.json(posts);
  } catch (error) {
    console.error('Feed fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch feed', details: error.message });
  }
});

router.get('/my-posts/:userId', authMiddleware, cacheMiddleware(60), async (req, res) => {
  try {
    const posts = await Post.find({ userId: req.params.userId }).sort({ createdAt: -1 });
    res.json(posts);
  } catch (error) {
    console.error('My posts fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch posts', details: error.message });
  }
});

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
    }

    const user = await User.findById(userId);
    const post = new Post({
      userId,
      contentType,
      content: contentUrl,
      caption,
      username: user.username,
      photo: user.photo,
      likedBy: [],
    });
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Post error:', { message: error.message, stack: error.stack, body: req.body, file: !!req.file });
    res.status(500).json({ error: 'Failed to post', details: error.message });
  }
});

router.delete('/post/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post || post.userId !== req.user.userId) return res.status(403).json({ error: 'Not authorized' });
    await post.remove();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post', details: error.message });
  }
});

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
    }

    const message = new Message({ senderId, recipientId, contentType, content: contentUrl, caption, status: 'sent' });
    await message.save();
    res.json(message);
  } catch (error) {
    console.error('Message error:', { message: error.message, stack: error.stack, body: req.body, file: !!req.file });
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

router.delete('/message/:messageId', authMiddleware, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message || message.senderId !== req.user.userId) return res.status(403).json({ error: 'Not authorized' });
    await message.remove();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message', details: error.message });
  }
});

router.post('/message/status', authMiddleware, async (req, res) => {
  try {
    const { messageId, status, recipientId } = req.body;
    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    message.status = status;
    await message.save();
    io.emit('messageStatus', { messageId, status });
    res.json({ success: true });
  } catch (error) {
    console.error('Message status error:', error);
    res.status(500).json({ error: 'Failed to update status', details: error.message });
  }
});

router.post('/like', authMiddleware, async (req, res) => {
  try {
    const { postId } = req.body;
    const { userId } = req.user;
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (!post.likedBy) post.likedBy = [];
    if (post.likedBy.includes(userId)) return res.status(400).json({ error: 'Already liked' });
    post.likes = (post.likes || 0) + 1;
    post.likedBy.push(userId);
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Like error:', error);
    res.status(500).json({ error: 'Failed to like post', details: error.message });
  }
});

router.post('/unlike', authMiddleware, async (req, res) => {
  try {
    const { postId } = req.body;
    const { userId } = req.user;
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (!post.likedBy?.includes(userId)) return res.status(400).json({ error: 'Not liked yet' });
    post.likes = (post.likes || 0) - 1;
    post.likedBy = post.likedBy.filter(id => id !== userId);
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Unlike error:', error);
    res.status(500).json({ error: 'Failed to unlike post', details: error.message });
  }
});

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