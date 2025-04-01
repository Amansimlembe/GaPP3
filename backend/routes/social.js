const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const User = require('../models/User');
const { authMiddleware } = require('./auth');
const redis = require('../redis');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

const socialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: (req) => req.ip,
});

const messageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many messages sent, please try again later.' },
  keyGenerator: (req) => req.ip,
});

const messageSchema = Joi.object({
  senderId: Joi.string().required(),
  recipientId: Joi.string().required(),
  contentType: Joi.string().valid('text', 'image', 'video', 'audio', 'document').required(),
  content: Joi.string().required(),
  plaintextContent: Joi.string().optional(),
  caption: Joi.string().max(500).allow('').optional(),
  replyTo: Joi.string().optional(),
  originalFilename: Joi.string().optional(),
  clientMessageId: Joi.string().optional(), // Add this
});
const messageStatusSchema = Joi.object({
  messageId: Joi.string().required(),
  status: Joi.string().valid('sent', 'delivered', 'read').required(),
  recipientId: Joi.string().required(),
});

module.exports = (io) => {
  io.on('connection', (socket) => {
    logger.info('User connected', { socketId: socket.id });

    socket.on('join', async (userId) => {
      socket.join(userId);
      const user = await User.findById(userId);
      if (!user) return logger.warn('User not found on join', { userId });
      user.status = 'online';
      user.lastSeen = new Date();
      await user.save();
      io.emit('onlineStatus', { userId, status: 'online', lastSeen: user.lastSeen });

      const undelivered = await redis.lrange(`undelivered:${userId}`, 0, -1);
      if (undelivered.length) {
        undelivered.forEach((msg) => io.to(userId).emit('message', JSON.parse(msg)));
        await redis.del(`undelivered:${userId}`);
      }
      logger.info('User joined', { userId });
    });

    socket.on('leave', async (userId) => {
      const user = await User.findById(userId);
      if (!user) return logger.warn('User not found on leave', { userId });
      user.status = 'offline';
      user.lastSeen = new Date();
      await user.save();
      io.emit('onlineStatus', { userId, status: 'offline', lastSeen: user.lastSeen });
      logger.info('User left', { userId });
    });

    socket.on('ping', async ({ userId }) => {
      const user = await User.findById(userId);
      if (!user) return;
      if (user.status !== 'online') {
        user.status = 'online';
        user.lastSeen = new Date();
        await user.save();
        io.emit('onlineStatus', { userId, status: 'online', lastSeen: user.lastSeen });
      }
    });

    socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
      const message = await Message.findById(messageId);
      if (!message || message.recipientId.toString() !== recipientId) return;
      message.status = status;
      await message.save();
      io.to(message.senderId).emit('messageStatus', { messageId, status });
      io.to(recipientId).emit('messageStatus', { messageId, status });
      logger.info('Message status updated', { messageId, status });
    });

    socket.on('typing', ({ userId, recipientId }) => io.to(recipientId).emit('typing', { userId }));
    socket.on('stopTyping', ({ userId, recipientId }) => io.to(recipientId).emit('stopTyping', { userId }));

    socket.on('disconnect', async () => {
      const userId = Array.from(socket.rooms).find((room) => room !== socket.id);
      if (userId) {
        const user = await User.findById(userId);
        if (user) {
          user.status = 'offline';
          user.lastSeen = new Date();
          await user.save();
          io.emit('onlineStatus', { userId, status: 'offline', lastSeen: user.lastSeen });
        }
        logger.info('User disconnected', { userId, socketId: socket.id });
      }
    });
  });
  router.post('/message', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { senderId, recipientId, contentType, content, plaintextContent, caption, replyTo, originalFilename } = req.body;
      if (!senderId || !recipientId || !contentType || !content) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
  
      const message = new Message({
        senderId,
        recipientId,
        contentType,
        content,
        plaintextContent: plaintextContent || '',
        caption,
        replyTo,
        originalFilename,
        status: 'sent',
        senderVirtualNumber: req.user.virtualNumber,
        senderUsername: req.user.username,
        senderPhoto: req.user.photo,
        clientMessageId, // Store this
      });
  
      await message.save();
      io.to(recipientId).emit('message', message.toObject());
      io.to(senderId).emit('message', message.toObject());
  
      res.json(message.toObject());
    } catch (error) {
      logger.error('Message send error', { error: error.message, stack: error.stack, body: req.body });
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  router.get('/messages', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { userId, recipientId, limit = 50, skip = 0 } = req.query;
      if (!userId || !recipientId || req.user.id !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }
  
      const messages = await Message.find({
        $or: [
          { senderId: userId, recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      })
        .sort({ createdAt: -1 })
        .skip(parseInt(skip))
        .limit(parseInt(limit))
        .lean();
  
      const total = await Message.countDocuments({
        $or: [
          { senderId: userId, recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      });
  
      res.json({ messages: messages.reverse(), hasMore: total > skip + limit });
    } catch (error) {
      logger.error('Messages fetch error', { error: error.message, stack: error.stack, query: req.query });
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

router.get('/chat-list', authMiddleware, socialLimiter, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId || req.user.id !== userId) return res.status(403).json({ error: 'Unauthorized' });

    // Get saved contacts
    const savedContacts = await User.findById(userId).select('contacts').lean() || { contacts: [] };
    const contactIds = savedContacts.contacts || [];

    // Get users who have messaged or been messaged by userId
    const messageParticipants = await Message.aggregate([
      { $match: { $or: [{ senderId: userId }, { recipientId: userId }] } },
      { $group: { _id: { $cond: [{ $eq: ['$senderId', userId] }, '$recipientId', '$senderId'] } } },
    ]).catch(() => []); // Fallback to empty array if aggregation fails
    const participantIds = messageParticipants.map((p) => p._id) || [];

    // Combine unique IDs
    const allIds = [...new Set([...contactIds, ...participantIds])];

    // Fetch user details
    const users = await User.find({ _id: { $in: allIds } })
      .select('virtualNumber username photo status lastSeen')
      .lean()
      .catch(() => []); // Fallback to empty array if query fails

    const usersWithData = await Promise.all(users.map(async (user) => {
      const latestMessageResult = await Message.find({
        $or: [{ senderId: userId, recipientId: user._id }, { senderId: user._id, recipientId: userId }],
      })
        .sort({ createdAt: -1 })
        .limit(1)
        .lean()
        .catch(() => []); // Fallback to empty array if query fails
      const latestMessage = latestMessageResult[0] || null;

      const unreadCountResult = await Message.countDocuments({
        senderId: user._id,
        recipientId: userId,
        status: { $ne: 'read' },
      }).catch(() => 0); // Fallback to 0 if count fails

      return {
        id: user._id.toString(),
        virtualNumber: user.virtualNumber || 'Unknown',
        username: user.username || '',
        photo: user.photo || 'https://placehold.co/40x40',
        status: user.status || 'offline',
        lastSeen: user.lastSeen || null,
        latestMessage,
        unreadCount: unreadCountResult,
        isSaved: contactIds.map(String).includes(user._id.toString()),
      };
    }));

    const sortedUsers = usersWithData.sort((a, b) => new Date(b.latestMessage?.createdAt || 0) - new Date(a.latestMessage?.createdAt || 0));
    res.json(sortedUsers);
  } catch (error) {
    logger.error('Chat list fetch error', { error: error.message, stack: error.stack, userId: req.query.userId });
    res.status(500).json({ error: 'Failed to fetch chat list' });
  }
});



  router.delete('/message/:messageId', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const message = await Message.findById(req.params.messageId);
      if (!message || message.senderId.toString() !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });
      await Message.deleteOne({ _id: req.params.messageId });
      io.to(message.recipientId).emit('messageDeleted', req.params.messageId);
      io.to(message.senderId).emit('messageDeleted', req.params.messageId);
      res.json({ success: true });
    } catch (error) {
      logger.error('Message deletion error', { error: error.message, messageId: req.params.messageId });
      res.status(500).json({ error: 'Failed to delete message' });
    }
  });

  router.post('/message/status', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { error } = messageStatusSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { messageId, status, recipientId } = req.body;
      if (req.user.id !== recipientId) return res.status(403).json({ error: 'Unauthorized' });

      const message = await Message.findById(messageId);
      if (!message || message.recipientId.toString() !== recipientId) return res.status(404).json({ error: 'Message not found or unauthorized' });

      message.status = status;
      await message.save();
      io.to(message.senderId).emit('messageStatus', { messageId, status });
      io.to(recipientId).emit('messageStatus', { messageId, status });
      res.json({ success: true });
    } catch (error) {
      logger.error('Message status update error', { error: error.message, messageId: req.body.messageId });
      res.status(500).json({ error: 'Failed to update message status' });
    }
  });

  return router;
};