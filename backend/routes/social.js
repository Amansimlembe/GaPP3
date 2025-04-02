const express = require('express');
const router = express.Router();
const { authMiddleware } = require('./auth');
const Message = require('../models/Message');
const User = require('../models/User');
const redis = require('../redis');
const winston = require('winston');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Configure Cloudinary
let cloudinaryConfigured = false;
const configureCloudinary = () => {
  if (!cloudinaryConfigured) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    cloudinaryConfigured = true;
  }
};



const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.get('/chat-list', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.query;
    const user = await User.findById(userId).populate('contacts', 'username virtualNumber photo status lastSeen');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const chatList = await Promise.all(user.contacts.map(async (contact) => {
      const latestMessage = await Message.findOne({ $or: [{ senderId: userId, recipientId: contact._id }, { senderId: contact._id, recipientId: userId }] })
        .sort({ createdAt: -1 })
        .select('content contentType plaintextContent senderId recipientId createdAt');
      const unreadCount = await Message.countDocuments({ senderId: contact._id, recipientId: userId, status: { $ne: 'read' } });
      return { id: contact._id, username: contact.username, virtualNumber: contact.virtualNumber, photo: contact.photo, status: contact.status, lastSeen: contact.lastSeen, latestMessage, unreadCount };
    }));

    res.json(chatList);
  } catch (error) {
    logger.error('Chat list error:', error);
    res.status(500).json({ error: 'Failed to fetch chat list' });
  }
});

router.get('/messages', authMiddleware, async (req, res) => {
  try {
    const { userId, recipientId, limit = 50, skip = 0, since } = req.query;
    const query = {
      $or: [{ senderId: userId, recipientId }, { senderId: recipientId, recipientId: userId }],
      ...(since ? { createdAt: { $gt: new Date(since) } } : {}),
    };
    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit) + 1);
    const hasMore = messages.length > limit;
    res.json({ messages: messages.slice(0, limit).reverse(), hasMore });
  } catch (error) {
    logger.error('Fetch messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

router.post('/message', authMiddleware, async (req, res) => {
  try {
    const { senderId, recipientId, contentType, content, plaintextContent, caption, replyTo, originalFilename, clientMessageId } = req.body;
    if (senderId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const message = new Message({
      senderId,
      recipientId,
      contentType,
      content,
      plaintextContent,
      caption,
      replyTo,
      originalFilename,
      clientMessageId,
      senderVirtualNumber: req.user.virtualNumber,
      senderUsername: req.user.username,
      senderPhoto: req.user.photo,
    });

    await message.save();
    const io = req.app.get('io');
    io.to(recipientId).emit('message', message);
    io.to(senderId).emit('message', message);

    await redis.lpush(`undelivered:${recipientId}`, JSON.stringify(message));
    res.json(message);
  } catch (error) {
    logger.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  configureCloudinary();
  try {
    const { userId, recipientId, clientMessageId } = req.body;
    if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'auto', folder: 'gapp_media' },
        (error, result) => (error ? reject(error) : resolve(result))
      ).end(req.file.buffer);
    });

    const contentType = req.file.mimetype.startsWith('image') ? 'image' :
                        req.file.mimetype.startsWith('video') ? 'video' :
                        req.file.mimetype.startsWith('audio') ? 'audio' : 'document';

    const message = new Message({
      senderId: userId,
      recipientId,
      contentType,
      content: result.secure_url,
      originalFilename: req.file.originalname,
      clientMessageId,
      senderVirtualNumber: req.user.virtualNumber,
      senderUsername: req.user.username,
      senderPhoto: req.user.photo,
    });

    await message.save();
    const io = req.app.get('io');
    io.to(recipientId).emit('message', message);
    io.to(userId).emit('message', message);

    res.json({ message });
  } catch (error) {
    logger.error('Media upload error:', error);
    res.status(500).json({ error: 'Failed to upload media' });
  }
});

router.post('/message/status', authMiddleware, async (req, res) => {
  try {
    const { messageId, status } = req.body;
    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.recipientId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    message.status = status;
    await message.save();

    const io = req.app.get('io');
    io.to(message.senderId).emit('messageStatus', { messageId, status });
    res.json({ messageId, status });
  } catch (error) {
    logger.error('Update message status error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

module.exports = (io) => {
  io.on('connection', (socket) => {
    socket.on('join', async (userId) => {
      socket.join(userId);
      await User.findByIdAndUpdate(userId, { status: 'online', lastSeen: null });
      io.emit('onlineStatus', { userId, status: 'online', lastSeen: null });
    });

    socket.on('typing', ({ userId, recipientId }) => {
      io.to(recipientId).emit('typing', { userId });
    });

    socket.on('stopTyping', ({ userId, recipientId }) => {
      io.to(recipientId).emit('stopTyping', { userId });
    });

    socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
      const message = await Message.findById(messageId);
      if (message && message.recipientId === recipientId) {
        message.status = status;
        await message.save();
        io.to(message.senderId).emit('messageStatus', { messageId, status });
      }
    });

    socket.on('disconnect', async () => {
      const userId = Array.from(socket.rooms)[1];
      if (userId) {
        await User.findByIdAndUpdate(userId, { status: 'offline', lastSeen: new Date() });
        io.emit('onlineStatus', { userId, status: 'offline', lastSeen: new Date() });
      }
    });
  });

  return router;
};