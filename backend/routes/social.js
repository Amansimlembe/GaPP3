const express = require('express');
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

const configureCloudinary = () => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    logger.error('Cloudinary configuration missing');
    throw new Error('Cloudinary configuration missing');
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });
  logger.info('Cloudinary configured');
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

module.exports = (io) => {
  const router = express.Router();

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
        })
          .sort({ createdAt: -1 })
          .select('content contentType plaintextContent senderId recipientId createdAt');

        return {
          id: contact._id.toString(),
          username: contact.username,
          virtualNumber: contact.virtualNumber,
          photo: contact.photo,
          status: contact.status || 'offline',
          lastSeen: contact.lastSeen,
          latestMessage: latestMessage ? {
            ...latestMessage.toObject(),
            senderId: latestMessage.senderId.toString(),
            recipientId: latestMessage.recipientId.toString(),
          } : null,
          unreadCount: await Message.countDocuments({
            senderId: contact._id,
            recipientId: userId,
            status: { $ne: 'read' },
          }),
        };
      }));

      res.json(chatList.sort((a, b) => new Date(b.latestMessage?.createdAt || 0) - new Date(a.latestMessage?.createdAt || 0)));
    } catch (error) {
      logger.error('Chat list fetch failed:', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to fetch chat list', details: error.message });
    }
  });

  router.get('/messages', authMiddleware, async (req, res) => {
    try {
      const { userId, recipientId, limit = 50, skip = 0, since } = req.query;
      if (!userId || !recipientId) return res.status(400).json({ error: 'userId and recipientId are required' });

      const query = {
        $or: [
          { senderId: userId, recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      };
      if (since) query.createdAt = { $gt: new Date(since) };

      const messages = await Message.find(query)
        .sort({ createdAt: 1 })
        .skip(Number(skip))
        .limit(Number(limit) + 1)
        .select('senderId recipientId content contentType plaintextContent status createdAt replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto');

      const hasMore = messages.length > Number(limit);
      if (hasMore) messages.pop();

      res.json({ messages, hasMore });
    } catch (error) {
      logger.error('Messages fetch failed:', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
    }
  });

  router.post('/message', authMiddleware, async (req, res) => {
    try {
      const {
        senderId, recipientId, content, contentType, plaintextContent, caption, replyTo, originalFilename, clientMessageId,
        senderVirtualNumber, senderUsername, senderPhoto,
      } = req.body;

      if (!senderId || !recipientId || !content || !contentType) {
        return res.status(400).json({ error: 'Missing required fields: senderId, recipientId, content, contentType' });
      }

      const sender = await User.findById(senderId);
      const recipient = await User.findById(recipientId);
      if (!sender || !recipient) {
        return res.status(404).json({ error: 'Sender or recipient not found' });
      }

      const message = new Message({
        senderId,
        recipientId,
        content,
        contentType,
        plaintextContent: plaintextContent || '',
        status: 'sent',
        caption: caption || undefined,
        replyTo: replyTo || undefined,
        originalFilename: originalFilename北大求職 || undefined,
        clientMessageId: clientMessageId || `${senderId}-${Date.now()}`,
        senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
        senderUsername: senderUsername || sender.username,
        senderPhoto: senderPhoto || sender.photo,
      });

      await message.save();
      if (!io) {
        logger.warn('Socket.IO not initialized for message emission');
      } else {
        io.to(recipientId).emit('message', message.toObject());
        io.to(senderId).emit('message', message.toObject());
      }

      res.status(201).json({ message });
    } catch (error) {
      logger.error('Message send failed:', { error: error.message, stack: error.stack, body: req.body });
      res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
  });

  router.post('/upload', upload.single('file'), authMiddleware, async (req, res) => {
    try {
      configureCloudinary();
      const { userId, recipientId, clientMessageId } = req.body;
      const file = req.file;

      if (!userId || !recipientId || !file) {
        return res.status(400).json({ error: 'Missing required fields: userId, recipientId, or file' });
      }

      const sender = await User.findById(userId);
      if (!sender) return res.status(404).json({ error: 'Sender not found' });

      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: file.mimetype.startsWith('video') ? 'video' : file.mimetype.startsWith('audio') ? 'auto' : 'image' },
          (error, result) => (error ? reject(error) : resolve(result))
        );
        stream.end(file.buffer);
      });

      const contentType = file.mimetype.startsWith('image') ? 'image' : file.mimetype.startsWith('video') ? 'video' : file.mimetype.startsWith('audio') ? 'audio' : 'document';
      const message = new Message({
        senderId: userId,
        recipientId,
        content: result.secure_url,
        contentType,
        status: 'sent',
        originalFilename: file.originalname,
        clientMessageId: clientMessageId || `${userId}-${Date.now()}`,
        senderVirtualNumber: sender.virtualNumber,
        senderUsername: sender.username,
        senderPhoto: sender.photo,
      });

      await message.save();
      if (!io) {
        logger.warn('Socket.IO not initialized for upload emission');
      } else {
        io.to(recipientId).emit('message', message.toObject());
        io.to(userId).emit('message', message.toObject());
      }

      res.status(201).json({ message });
    } catch (error) {
      logger.error('File upload failed:', { error: error.message, stack: error.stack, body: req.body });
      res.status(500).json({ error: 'Failed to upload file', details: error.message });
    }
  });

  return router;
};