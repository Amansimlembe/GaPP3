const express = require('express');
const jwt = require('jsonwebtoken');
const { authMiddleware } = require('./auth');
const Message = require('../models/Message');
const User = require('../models/User');
const winston = require('winston');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const Joi = require('joi');
const mongoose = require('mongoose');
const validator = require('validator');

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
  let cloudinaryConfig = {};
  if (process.env.CLOUDINARY_URL) {
    try {
      const url = new URL(process.env.CLOUDINARY_URL);
      cloudinaryConfig = {
        cloud_name: url.hostname,
        api_key: url.username,
        api_secret: url.password,
      };
    } catch (err) {
      logger.error('Invalid CLOUDINARY_URL format', { error: err.message });
      throw new Error(`Invalid CLOUDINARY_URL format: ${err.message}`);
    }
  } else if (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    cloudinaryConfig = {
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    };
  } else {
    logger.error('Cloudinary configuration missing');
    throw new Error('Cloudinary configuration missing');
  }
  cloudinary.config(cloudinaryConfig);
  logger.info('Cloudinary configured', {
    cloud_name: cloudinaryConfig.cloud_name,
    api_key: cloudinaryConfig.api_key ? '****' : undefined,
  });
};
configureCloudinary();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/', 'video/', 'audio/', 'application/'];
    if (allowedTypes.some((type) => file.mimetype.startsWith(type))) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  },
});

const validContentTypes = ['text', 'image', 'video', 'audio', 'document'];

const messageSchema = Joi.object({
  senderId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }, 'ObjectId validation').required().messages({ 'any.invalid': 'Invalid senderId' }),
  recipientId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }, 'ObjectId validation').required().messages({ 'any.invalid': 'Invalid recipientId' }),
  content: Joi.string().required().when('contentType', {
    is: 'text',
    then: Joi.string().pattern(/^[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/, 'encrypted format'),
    otherwise: Joi.string().custom((value, helpers) => {
      if (!validator.isURL(value)) return helpers.error('any.invalid');
      return value;
    }, 'URL validation'),
  }).messages({
    'string.pattern.name': 'Text content must be in encrypted format (data|iv|key)',
    'any.invalid': 'Media content must be a valid URL',
  }),
  contentType: Joi.string().valid(...validContentTypes).required().messages({
    'any.only': `contentType must be one of: ${validContentTypes.join(', ')}`,
  }),
  plaintextContent: Joi.string().required().messages({ 'string.empty': 'plaintextContent required for text messages' }),
  caption: Joi.string().optional(),
  replyTo: Joi.string().custom((value, helpers) => {
    if (value && !mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }, 'ObjectId validation').optional().messages({ 'any.invalid': 'Invalid replyTo ID' }),
  originalFilename: Joi.string().optional(),
  clientMessageId: Joi.string().required().messages({ 'string.empty': 'clientMessageId required' }),
  senderVirtualNumber: Joi.string().optional(),
  senderUsername: Joi.string().optional(),
  senderPhoto: Joi.string().optional(),
});

const addContactSchema = Joi.object({
  userId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }, 'ObjectId validation').required(),
  virtualNumber: Joi.string().required(),
});

const deleteUserSchema = Joi.object({
  userId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }, 'ObjectId validation').required(),
});

module.exports = (io) => {
  const router = express.Router();

  // Socket.IO middleware for token validation
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      logger.warn('No token provided for Socket.IO', { socketId: socket.id });
      return next(new Error('No token provided'));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      const blacklisted = await mongoose.model('TokenBlacklist').findOne({ token }).select('_id').lean();
      if (blacklisted) {
        logger.warn('Blacklisted token used for Socket.IO', { socketId: socket.id });
        return next(new Error('Token invalidated'));
      }
      socket.user = decoded;
      next();
    } catch (error) {
      logger.error('Socket.IO auth error', { error: error.message, socketId: socket.id });
      next(new Error('Invalid token'));
    }
  });

  const emitUpdatedChatList = async (userId) => {
    try {
      if (!mongoose.isValidObjectId(userId)) {
        logger.warn('Invalid userId in emitUpdatedChatList', { userId });
        return;
      }

      const user = await User.findById(userId).select('contacts').lean();
      if (!user) {
        logger.warn('User not found in emitUpdatedChatList', { userId });
        io.to(userId).emit('chatListUpdated', { userId, users: [] });
        return;
      }

      const contacts = Array.isArray(user.contacts) ? user.contacts : [];
      if (!contacts.length) {
        io.to(userId).emit('chatListUpdated', { userId, users: [] });
        return;
      }

      const contactUsers = await User.find({ _id: { $in: contacts } })
        .select('username virtualNumber photo status lastSeen')
        .lean();

      const chatList = await Promise.all(
        contactUsers.map(async (contact) => {
          const latestMessage = await Message.findOne({
            $or: [
              { senderId: userId, recipientId: contact._id },
              { senderId: contact._id, recipientId: userId },
            ],
          })
            .sort({ createdAt: -1 })
            .select('content contentType senderId recipientId createdAt plaintextContent senderVirtualNumber senderUsername senderPhoto')
            .lean();

          const unreadCount = await Message.countDocuments({
            senderId: contact._id,
            recipientId: userId,
            status: { $ne: 'read' },
          });

          return {
            id: contact._id.toString(),
            username: contact.username || 'Unknown',
            virtualNumber: contact.virtualNumber || '',
            photo: contact.photo || 'https://placehold.co/40x40',
            status: contact.status || 'offline',
            lastSeen: contact.lastSeen || null,
            latestMessage: latestMessage || null,
            unreadCount: unreadCount || 0,
          };
        })
      );

      io.to(userId).emit('chatListUpdated', { userId, users: chatList });
      logger.info('Emitted updated chat list', { userId, chatCount: chatList.length });
    } catch (error) {
      logger.error('Failed to emit updated chat list', { error: error.message, stack: error.stack, userId });
    }
  };

  io.on('connection', (socket) => {
    logger.info('New Socket.IO connection', { socketId: socket.id, userId: socket.user?.id });

    socket.on('join', (userId) => {
      if (!mongoose.isValidObjectId(userId) || userId !== socket.user.id) {
        logger.warn('Invalid or unauthorized join attempt', { socketId: socket.id, userId });
        return;
      }
      socket.join(userId);
      User.findByIdAndUpdate(userId, { status: 'online', lastSeen: new Date() }, { new: true, lean: true })
        .then((user) => {
          if (user) {
            io.to(userId).emit('userStatus', { userId, status: 'online', lastSeen: user.lastSeen });
            emitUpdatedChatList(userId);
            logger.info('User joined room', { socketId: socket.id, userId });
          }
        })
        .catch((err) => logger.error('User join failed', { error: err.message, stack: err.stack, userId }));
    });

    socket.on('leave', (userId) => {
      if (!mongoose.isValidObjectId(userId) || userId !== socket.user.id) {
        logger.warn('Invalid or unauthorized leave attempt', { socketId: socket.id, userId });
        return;
      }
      User.findByIdAndUpdate(userId, { status: 'offline', lastSeen: new Date() }, { new: true, lean: true })
        .then((user) => {
          if (user) {
            io.to(userId).emit('userStatus', { userId, status: 'offline', lastSeen: user.lastSeen });
            logger.info('User left room', { socketId: socket.id, userId });
          }
        })
        .catch((err) => logger.error('User leave failed', { error: err.message, stack: err.stack, userId }));
      socket.leave(userId);
    });

    socket.on('typing', ({ userId, recipientId }) => {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId) || userId !== socket.user.id) {
        return;
      }
      io.to(recipientId).emit('typing', { userId });
    });

    socket.on('stopTyping', ({ userId, recipientId }) => {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId) || userId !== socket.user.id) {
        return;
      }
      io.to(recipientId).emit('stopTyping', { userId });
    });

    socket.on('contactData', async ({ userId, contactData }) => {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(contactData.id) || userId !== socket.user.id) {
        logger.warn('Invalid contactData event', { userId, socketId: socket.id });
        return;
      }
      try {
        const contact = await User.findById(contactData.id).select('username virtualNumber photo status lastSeen').lean();
        if (contact) {
          const contactObj = {
            id: contact._id.toString(),
            username: contact.username || 'Unknown',
            virtualNumber: contact.virtualNumber || '',
            photo: contact.photo || 'https://placehold.co/40x40',
            status: contact.status || 'offline',
            lastSeen: contact.lastSeen || null,
            latestMessage: null,
            unreadCount: 0,
          };
          io.to(userId).emit('contactData', { userId, contactData: contactObj });
          io.to(contactData.id).emit('contactData', {
            userId: contactData.id,
            contactData: {
              id: userId,
              username: (await User.findById(userId).select('username')).username || 'Unknown',
              virtualNumber: (await User.findById(userId).select('virtualNumber')).virtualNumber || '',
              photo: (await User.findById(userId).select('photo')).photo || 'https://placehold.co/40x40',
              status: (await User.findById(userId).select('status')).status || 'offline',
              lastSeen: (await User.findById(userId).select('lastSeen')).lastSeen || null,
              latestMessage: null,
              unreadCount: 0,
            },
          });
          await Promise.all([emitUpdatedChatList(userId), emitUpdatedChatList(contactData.id)]);
        }
      } catch (err) {
        logger.error('Contact data emission failed', { error: err.message, stack: err.stack, userId });
      }
    });

    socket.on('message', async (messageData, callback) => {
      try {
        const { error } = messageSchema.validate(messageData);
        if (error) {
          return callback({ error: error.details[0].message });
        }

        const {
          senderId,
          recipientId,
          content,
          contentType,
          plaintextContent,
          caption,
          replyTo,
          clientMessageId,
          senderVirtualNumber,
          senderUsername,
          senderPhoto,
        } = messageData;

        if (senderId !== socket.user.id) {
          return callback({ error: 'Unauthorized sender' });
        }

        if (contentType === 'text' && !plaintextContent) {
          return callback({ error: 'plaintextContent required for text messages' });
        }

        const existingMessage = await Message.findOne({ clientMessageId }).lean();
        if (existingMessage) {
          return callback({ message: existingMessage });
        }

        const sender = await User.findById(senderId).select('virtualNumber username photo').lean();
        const message = new Message({
          senderId,
          recipientId,
          content,
          contentType,
          plaintextContent,
          status: 'sent',
          caption: caption || undefined,
          replyTo: replyTo && mongoose.isValidObjectId(replyTo) ? replyTo : undefined,
          originalFilename: messageData.originalFilename || undefined,
          clientMessageId,
          senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
          senderUsername: senderUsername || sender.username,
          senderPhoto: senderPhoto || sender.photo,
        });

        await message.save();

        const populatedMessage = await Message.findById(message._id)
          .populate('senderId', 'username virtualNumber photo')
          .populate('recipientId', 'username virtualNumber photo')
          .populate('replyTo', 'content contentType senderId recipientId createdAt')
          .lean();

        io.to(recipientId).emit('message', populatedMessage);
        io.to(senderId).emit('message', populatedMessage);

        await Promise.all([emitUpdatedChatList(senderId), emitUpdatedChatList(recipientId)]);

        callback({ message: populatedMessage });
      } catch (err) {
        logger.error('Message send failed', { error: err.message, stack: err.stack, senderId: messageData.senderId });
        callback({ error: err.message });
      }
    });

    socket.on('editMessage', async ({ messageId, newContent, plaintextContent }, callback) => {
      try {
        if (!mongoose.isValidObjectId(messageId)) {
          return callback({ error: 'Invalid messageId' });
        }

        const message = await Message.findById(messageId);
        if (!message) {
          return callback({ error: 'Message not found' });
        }

        if (message.senderId.toString() !== socket.user.id) {
          return callback({ error: 'Unauthorized to edit message' });
        }

        message.content = newContent;
        message.plaintextContent = plaintextContent || '';
        message.updatedAt = new Date();
        await message.save();

        const populatedMessage = await Message.findById(message._id)
          .populate('senderId', 'username virtualNumber photo')
          .populate('recipientId', 'username virtualNumber photo')
          .populate('replyTo', 'content contentType senderId recipientId createdAt')
          .lean();

        io.to(message.recipientId.toString()).emit('editMessage', populatedMessage);
        io.to(message.senderId.toString()).emit('editMessage', populatedMessage);

        callback({ message: populatedMessage });
      } catch (err) {
        logger.error('Edit message failed', { error: err.message, stack: err.stack, messageId });
        callback({ error: 'Failed to edit message' });
      }
    });

    socket.on('deleteMessage', async ({ messageId, recipientId }, callback) => {
      try {
        if (!mongoose.isValidObjectId(messageId) || !mongoose.isValidObjectId(recipientId)) {
          return callback({ error: 'Invalid messageId or recipientId' });
        }

        const message = await Message.findById(messageId);
        if (!message) {
          return callback({ error: 'Message not found' });
        }

        if (message.senderId.toString() !== socket.user.id) {
          return callback({ error: 'Unauthorized to delete message' });
        }

        await Message.findByIdAndDelete(messageId);

        io.to(recipientId).emit('deleteMessage', { messageId, recipientId });
        io.to(message.senderId.toString()).emit('deleteMessage', { messageId, recipientId: message.senderId.toString() });

        await Promise.all([emitUpdatedChatList(message.senderId.toString()), emitUpdatedChatList(recipientId)]);

        callback({ status: 'success' });
      } catch (err) {
        logger.error('Delete message failed', { error: err.message, stack: err.stack, messageId });
        callback({ error: 'Failed to delete message' });
      }
    });

    socket.on('messageStatus', async ({ messageId, status }) => {
      try {
        if (!mongoose.isValidObjectId(messageId) || !['sent', 'delivered', 'read'].includes(status)) {
          return;
        }

        const message = await Message.findById(messageId);
        if (!message) {
          return;
        }

        if (message.recipientId.toString() !== socket.user.id) {
          return;
        }

        message.status = status;
        await message.save();

        io.to(message.senderId.toString()).emit('messageStatus', { messageId, status });
      } catch (err) {
        logger.error('Message status update failed', { error: err.message, stack: err.stack, messageId });
      }
    });

    socket.on('batchMessageStatus', async ({ messageIds, status, recipientId }) => {
      try {
        if (!messageIds.every((id) => mongoose.isValidObjectId(id)) || !mongoose.isValidObjectId(recipientId)) {
          return;
        }

        if (recipientId !== socket.user.id) {
          return;
        }

        const messages = await Message.find({ _id: { $in: messageIds }, recipientId });
        if (!messages.length) {
          return;
        }

        await Message.updateMany(
          { _id: { $in: messageIds }, recipientId },
          { status, updatedAt: new Date() }
        );

        const senderIds = [...new Set(messages.map((msg) => msg.senderId.toString()))];
        senderIds.forEach((senderId) => {
          io.to(senderId).emit('messageStatus', { messageIds, status });
        });
      } catch (err) {
        logger.error('Batch message status update failed', { error: err.message, stack: err.stack, recipientId });
      }
    });

    socket.on('disconnect', () => {
      if (socket.user?.id) {
        User.findByIdAndUpdate(socket.user.id, { status: 'offline', lastSeen: new Date() }, { new: true, lean: true })
          .then((user) => {
            if (user) {
              io.to(socket.user.id).emit('userStatus', { userId: socket.user.id, status: 'offline', lastSeen: user.lastSeen });
            }
          })
          .catch((err) => logger.error('User disconnect status update failed', { error: err.message, stack: err.stack, userId: socket.user.id }));
      }
      logger.info('Socket.IO disconnected', { socketId: socket.id, userId: socket.user?.id });
    });
  });

  router.get('/health', async (req, res) => {
    res.json({ status: 'healthy' });
  });

  router.post('/messages', authMiddleware, async (req, res) => {
    try {
      const { error } = messageSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const {
        senderId,
        recipientId,
        content,
        contentType,
        plaintextContent,
        caption,
        replyTo,
        clientMessageId,
        senderVirtualNumber,
        senderUsername,
        senderPhoto,
      } = req.body;

      if (senderId !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized sender' });
      }

      if (contentType === 'text' && !plaintextContent) {
        return res.status(400).json({ error: 'plaintextContent required for text messages' });
      }

      const existingMessage = await Message.findOne({ clientMessageId }).lean();
      if (existingMessage) {
        return res.status(200).json({ message: existingMessage });
      }

      const sender = await User.findById(senderId).select('virtualNumber username photo').lean();
      const message = new Message({
        senderId,
        recipientId,
        content,
        contentType,
        plaintextContent,
        status: 'sent',
        caption: caption || undefined,
        replyTo: replyTo && mongoose.isValidObjectId(replyTo) ? replyTo : undefined,
        originalFilename: req.body.originalFilename || undefined,
        clientMessageId,
        senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
        senderUsername: senderUsername || sender.username,
        senderPhoto: senderPhoto || sender.photo,
      });

      await message.save();

      const populatedMessage = await Message.findById(message._id)
        .populate('senderId', 'username virtualNumber photo')
        .populate('recipientId', 'username virtualNumber photo')
        .populate('replyTo', 'content contentType senderId recipientId createdAt')
        .lean();

      io.to(recipientId).emit('message', populatedMessage);
      io.to(senderId).emit('message', populatedMessage);

      await Promise.all([emitUpdatedChatList(senderId), emitUpdatedChatList(recipientId)]);

      res.status(201).json({ message: populatedMessage });
    } catch (error) {
      logger.error('Save message error:', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to save message', details: error.message });
    }
  });

  router.get('/chat-list', authMiddleware, async (req, res) => {
    const { userId } = req.query;
    try {
      if (!mongoose.isValidObjectId(userId) || userId !== req.user.id) {
        logger.warn('Invalid or unauthorized userId', { userId, authenticatedUser: req.user.id });
        return res.status(400).json({ error: 'Invalid or unauthorized userId' });
      }

      const user = await User.findById(userId).select('contacts').lean();
      if (!user) {
        logger.warn('User not found', { userId });
        return res.status(404).json({ error: 'User not found' });
      }

      const contacts = Array.isArray(user.contacts) ? user.contacts : [];
      if (!contacts.length) {
        logger.info('No valid contacts found for user', { userId });
        return res.json([]);
      }

      const contactUsers = await User.find({ _id: { $in: contacts } })
        .select('username virtualNumber photo status lastSeen')
        .lean();

      const chatList = await Promise.all(
        contactUsers.map(async (contact) => {
          const latestMessage = await Message.findOne({
            $or: [
              { senderId: userId, recipientId: contact._id },
              { senderId: contact._id, recipientId: userId },
            ],
          })
            .sort({ createdAt: -1 })
            .select('content contentType senderId recipientId createdAt plaintextContent senderVirtualNumber senderUsername senderPhoto')
            .lean();

          const unreadCount = await Message.countDocuments({
            senderId: contact._id,
            recipientId: userId,
            status: { $ne: 'read' },
          });

          return {
            id: contact._id.toString(),
            username: contact.username || 'Unknown',
            virtualNumber: contact.virtualNumber || '',
            photo: contact.photo || 'https://placehold.co/40x40',
            status: contact.status || 'offline',
            lastSeen: contact.lastSeen || null,
            latestMessage: latestMessage || null,
            unreadCount: unreadCount || 0,
          };
        })
      );

      logger.info('Chat list fetched successfully', { userId, chatCount: chatList.length });
      res.json(chatList);
    } catch (err) {
      logger.error('Chat list failed', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: 'Failed to fetch chat list', details: err.message });
    }
  });

  router.get('/messages', authMiddleware, async (req, res) => {
    const { userId, recipientId, limit = 50, skip = 0 } = req.query;
    try {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId) || userId !== req.user.id) {
        return res.status(400).json({ error: 'Invalid or unauthorized userId or recipientId' });
      }

      const messages = await Message.find({
        $or: [
          { senderId: userId, recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      })
        .sort({ createdAt: 1 })
        .skip(parseInt(skip))
        .limit(parseInt(limit))
        .populate('senderId', 'username virtualNumber photo')
        .populate('recipientId', 'username virtualNumber photo')
        .populate('replyTo', 'content contentType senderId recipientId createdAt')
        .lean();

      const total = await Message.countDocuments({
        $or: [
          { senderId: userId, recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      });

      res.json({ messages, total });
    } catch (err) {
      logger.error('Messages fetch failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to fetch messages', details: err.message });
    }
  });

  router.post('/add_contact', authMiddleware, async (req, res) => {
    try {
      const { error } = addContactSchema.validate(req.body);
      if (error) {
        logger.warn('Invalid request body', { error: error.details[0].message, userId: req.body.userId });
        return res.status(400).json({ error: 'Invalid request data' });
      }

      const { userId, virtualNumber } = req.body;
      if (!userId || userId !== req.user.id) {
        logger.warn('Unauthorized user', { userId, authenticatedUser: req.user.id });
        return res.status(403).json({ error: 'Unauthorized' });
      }

      const user = await User.findById(userId).select('_id username virtualNumber photo status lastSeen contacts');
      if (!user) {
        logger.warn('User not found', { userId });
        return res.status(404).json({ error: 'User not found' });
      }

      const contact = await User.findOne({ virtualNumber }).select('_id username virtualNumber photo status lastSeen contacts');
      if (!contact) {
        logger.info('Contact not found', { userId, virtualNumber });
        return res.status(404).json({ error: 'The contact is not registered' });
      }

      if (contact._id.toString() === userId) {
        logger.warn('Attempt to add self as contact', { userId });
        return res.status(400).json({ error: 'Cannot add self as contact' });
      }

      user.contacts = Array.isArray(user.contacts) ? user.contacts : [];
      contact.contacts = Array.isArray(contact.contacts) ? contact.contacts : [];

      const userHasContact = user.contacts.some((id) => id.toString() === contact._id.toString());
      const contactHasUser = contact.contacts.some((id) => id.toString() === userId);

      if (userHasContact && contactHasUser) {
        logger.info('Contact already exists', { userId, contactId: contact._id });
        const contactData = {
          id: contact._id.toString(),
          username: contact.username || 'Unknown',
          virtualNumber: contact.virtualNumber || '',
          photo: contact.photo || 'https://placehold.co/40x40',
          status: contact.status || 'offline',
          lastSeen: contact.lastSeen || null,
          latestMessage: null,
          unreadCount: 0,
        };
        return res.status(200).json(contactData);
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (!userHasContact) {
            await User.updateOne(
              { _id: userId },
              { $addToSet: { contacts: contact._id } },
              { session }
            );
            logger.info('Updated user contacts', { userId, contactId: contact._id.toString() });
          }

          if (!contactHasUser) {
            await User.updateOne(
              { _id: contact._id },
              { $addToSet: { contacts: user._id } },
              { session }
            );
            logger.info('Updated contact contacts', { userId, contactId: contact._id.toString() });
          }
        });
      } catch (transactionError) {
        logger.error('Transaction failed', {
          error: transactionError.message,
          stack: transactionError.stack,
          userId,
          contactId: contact._id.toString(),
        });
        return res.status(500).json({ error: 'Failed to add contact', details: transactionError.message });
      } finally {
        session.endSession();
      }

      const contactData = {
        id: contact._id.toString(),
        username: contact.username || 'Unknown',
        virtualNumber: contact.virtualNumber || '',
        photo: contact.photo || 'https://placehold.co/40x40',
        status: contact.status || 'offline',
        lastSeen: contact.lastSeen || null,
        latestMessage: null,
        unreadCount: 0,
      };

      io.to(userId).emit('contactData', { userId, contactData });
      io.to(contact._id.toString()).emit('contactData', {
        userId: contact._id.toString(),
        contactData: {
          id: user._id.toString(),
          username: user.username || 'Unknown',
          virtualNumber: user.virtualNumber || '',
          photo: user.photo || 'https://placehold.co/40x40',
          status: user.status || 'offline',
          lastSeen: user.lastSeen || null,
          latestMessage: null,
          unreadCount: 0,
        },
      });

      await Promise.all([emitUpdatedChatList(userId), emitUpdatedChatList(contact._id.toString())]);

      logger.info('Contact added successfully', { userId, contactId: contact._id.toString() });
      res.status(201).json(contactData);
    } catch (error) {
      logger.error('Add contact failed', {
        error: error.message,
        stack: error.stack,
        userId: req.body.userId,
        virtualNumber: req.body.virtualNumber,
      });
      return res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
  });

  router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
    try {
      const { userId, recipientId, clientMessageId, senderVirtualNumber, senderUsername, senderPhoto, caption } = req.body;
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId) || !clientMessageId || !req.file || userId !== req.user.id) {
        return res.status(400).json({ error: 'Invalid or unauthorized parameters' });
      }

      const existingMessage = await Message.findOne({ clientMessageId }).lean();
      if (existingMessage) {
        return res.json({ message: existingMessage });
      }

      const contentType = req.file.mimetype.startsWith('image/')
        ? 'image'
        : req.file.mimetype.startsWith('video/')
        ? 'video'
        : req.file.mimetype.startsWith('audio/')
        ? 'audio'
        : 'document';

      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { resource_type: contentType === 'document' ? 'raw' : contentType },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        require('stream').Readable.from(req.file.buffer).pipe(uploadStream);
      });

      const sender = await User.findById(userId).select('virtualNumber username photo').lean();
      const message = new Message({
        senderId: userId,
        recipientId,
        content: uploadResult.secure_url,
        contentType,
        plaintextContent: '',
        status: 'sent',
        caption: caption || undefined,
        originalFilename: req.file.originalname,
        clientMessageId,
        senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
        senderUsername: senderUsername || sender.username,
        senderPhoto: senderPhoto || sender.photo,
      });

      await message.save();

      const populatedMessage = await Message.findById(message._id)
        .populate('senderId', 'username virtualNumber photo')
        .populate('recipientId', 'username virtualNumber photo')
        .populate('replyTo', 'content contentType senderId recipientId createdAt')
        .lean();

      io.to(recipientId).emit('message', populatedMessage);
      io.to(userId).emit('message', populatedMessage);

      await Promise.all([emitUpdatedChatList(userId), emitUpdatedChatList(recipientId)]);

      res.json({ message: populatedMessage });
    } catch (err) {
      logger.error('Media upload failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to upload media', details: err.message });
    }
  });

  router.post('/delete_user', authMiddleware, async (req, res) => {
    try {
      const { error } = deleteUserSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { userId } = req.body;
      if (userId !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const contacts = await User.find({ contacts: userId }).select('_id').lean();
      const contactIds = contacts.map((contact) => contact._id.toString());

      await Message.deleteMany({ $or: [{ senderId: userId }, { recipientId: userId }] });

      await User.updateMany({ contacts: userId }, { $pull: { contacts: userId } });

      await User.findByIdAndDelete(userId);

      io.to(userId).emit('userStatus', { userId, status: 'offline', lastSeen: new Date() });
      contactIds.forEach((contactId) => {
        io.to(contactId).emit('userDeleted', { userId });
      });

      await Promise.all(contactIds.map((contactId) => emitUpdatedChatList(contactId)));

      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      logger.error('User deletion failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to delete user', details: err.message });
    }
  });

  router.post('/log-error', async (req, res) => {
    try {
      const { error, stack, userId, route, timestamp } = req.body;
      logger.error('Client-side error reported', {
        error,
        stack,
        userId,
        route,
        timestamp,
      });
      res.status(200).json({ message: 'Error logged successfully' });
    } catch (err) {
      logger.error('Failed to log client error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to log error', details: err.message });
    }
  });

  return router;
};