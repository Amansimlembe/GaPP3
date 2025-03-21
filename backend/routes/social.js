const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const Message = require('../models/Message');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const authMiddleware = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage() });

router.get('/feed', async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    res.json(posts);
  } catch (error) {
    console.error('Feed fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch feed', details: error.message });
  }
});

router.post('/post', authMiddleware, upload.single('content'), async (req, res) => {
  try {
    const { userId } = req.user;
    const { contentType, caption } = req.body;
    if (!contentType) return res.status(400).json({ error: 'Content type is required' });

    let contentUrl = caption || '';
    if (req.file) {
      const resourceType = contentType === 'text' ? 'raw' : contentType;
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
      console.log('Uploaded media URL:', contentUrl);
    }

    const post = new Post({ userId, contentType, content: contentUrl });
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Post error:', { message: error.message, stack: error.stack, body: req.body, file: !!req.file });
    res.status(500).json({ error: 'Failed to post', details: error.message });
  }
});

router.post('/message', authMiddleware, upload.single('content'), async (req, res) => {
  try {
    const { senderId, recipientId, contentType } = req.body;
    if (!senderId || !recipientId || !contentType) {
      return res.status(400).json({ error: 'Sender ID, recipient ID, and content type are required' });
    }

    let contentUrl = req.body.content || '';
    if (req.file) {
      const resourceType = contentType === 'text' ? 'raw' : contentType;
      const result = await cloudinary.uploader.upload_stream(
        { resource_type: resourceType, public_id: `${contentType}_${senderId}_${Date.now()}`, folder: `gapp_chat_${contentType}s` },
        (error, result) => {
          if (error) throw error;
          return result;
        }
      ).end(req.file.buffer);
      contentUrl = result.secure_url;
    }

    const message = new Message({ senderId, recipientId, contentType, content: contentUrl });
    await message.save();
    res.json(message);
  } catch (error) {
    console.error('Message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
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

module.exports = router;