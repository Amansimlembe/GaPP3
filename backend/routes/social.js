const express = require('express');
const router = express.Router();
const { authMiddleware } = require('./auth');
const Message = require('../models/Message');
const User = require('../models/User');
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

const configureCloudinary = () => {
  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      throw new Error('Cloudinary environment variables are missing');
    }
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    logger.info('Cloudinary configured');
  } catch (error) {
    logger.error('Cloudinary configuration failed', { error: error.message });
    throw error;
  }
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.get('/chat-list', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const user = await User.findById(userId).populate('contacts', 'username virtualNumber photo status lastSeen');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const chatList = await Promise.all(user.contacts.map(async (contact) => {
      const latestMessage = await Message.findOne({
        $or: [
          { senderId: userId, recipientId: contact._id },
          { senderId: contact._id, recipientId: userId },
        ],
      }).sort({ createdAt: -1 }).lean();

      return {
        id: contact._id.toString(),
        username: contact.username,
        virtualNumber: contact.virtualNumber,
        photo: contact.photo,
        status: contact.status || 'offline',
        lastSeen: contact.lastSeen,
        latestMessage: latestMessage ? { ...latestMessage, senderId: latestMessage.senderId.toString(), recipientId: latestMessage.recipientId.toString() } : null,
        unreadCount: await Message.countDocuments({ senderId: contact._id, recipientId: userId, status: { $ne: 'read' } }),
      };
    }));

    res.json(chatList.sort((a, b) => new Date(b.latestMessage?.createdAt || 0) - new Date(a.latestMessage?.createdAt || 0)));
  } catch (error) {
    logger.error('Chat list fetch failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to fetch chat list' });
  }
});

router.get('/messages', authMiddleware, async (req, res) => {
  try {
    const { userId, recipientId, limit = 50, skip = 0 } = req.query;
    if (!userId || !recipientId) return res.status(400).json({ error: 'userId and recipientId are required' });

    const messages = await Message.find({
      $or: [
        { senderId: userId, recipientId },
        { senderId: recipientId, recipientId: userId },
      ],
    })
      .sort({ createdAt: 1 })
      .skip(Number(skip))
      .limit(Number(limit))
      .lean();

    res.json({ messages, hasMore: messages.length === Number(limit) });
  } catch (error) {
    logger.error('Messages fetch failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

router.post('/message', authMiddleware, async (req, res) => {
  try {
    const {
      senderId, recipientId, content, contentType, plaintextContent, caption, replyTo, originalFilename, clientMessageId,
      senderVirtualNumber, senderUsername, senderPhoto,
    } = req.body;

    if (!senderId || !recipientId || !content || !contentType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const message = new Message({
      senderId,
      recipientId,
      content,
      contentType,
      plaintextContent: plaintextContent || '',
      status: 'sent',
      caption: caption || '',
      replyTo: replyTo || null,
      originalFilename: originalFilename || null,
      clientMessageId: clientMessageId || null,
      senderVirtualNumber: senderVirtualNumber || '',
      senderUsername: senderUsername || '',
      senderPhoto: senderPhoto || '',
    });

    await message.save();
    const io = req.app.get('io');
    io.to(recipientId).emit('message', message);
    io.to(senderId).emit('message', message);

    res.status(201).json({ message });
  } catch (error) {
    logger.error('Message send failed', { error: error.message, stack: error.stack, body: req.body });
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

router.post('/upload', upload.single('file'), authMiddleware, async (req, res) => {
  try {
    configureCloudinary();
    const { userId, recipientId, clientMessageId } = req.body;
    const file = req.file;

    if (!userId || !recipientId || !file) return res.status(400).json({ error: 'Missing required fields' });

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: file.mimetype.startsWith('video') ? 'video' : file.mimetype.startsWith('audio') ? 'auto' : 'image' },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(file.buffer);
    });

    const contentType = file.mimetype.startsWith('image') ? 'image' :
                        file.mimetype.startsWith('video') ? 'video' :
                        file.mimetype.startsWith('audio') ? 'audio' : 'document';

    const message = new Message({
      senderId: userId,
      recipientId,
      content: result.secure_url,
      contentType,
      status: 'sent',
      originalFilename: file.originalname,
      clientMessageId: clientMessageId || null,
    });

    await message.save();
    const io = req.app.get('io');
    io.to(recipientId).emit('message', message);
    io.to(userId).emit('message', message);

    res.status(201).json({ message });
  } catch (error) {
    logger.error('File upload failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to upload file', details: error.message });
  }
});

module.exports = router;