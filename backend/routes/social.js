const express = require('express');
const jwt = require('jsonwebtoken');
const { authMiddleware } = require('./auth');
const Message = require('../models/Message');
const User = require('../models/User');
const memcached = require('../memcached');
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

// Initialize Cloudinary
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
  senderId: Joi.string()
    .custom((value, helpers) => {
      if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
      return value;
    }, 'ObjectId validation')
    .required()
    .messages({ 'any.invalid': 'Invalid senderId' }),
  recipientId: Joi.string()
    .custom((value, helpers) => {
      if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
      return value;
    }, 'ObjectId validation')
    .required()
    .messages({ 'any.invalid': 'Invalid recipientId' }),
  content: Joi.string()
    .required()
    .when('contentType', {
      is: 'text',
      then: Joi.string().pattern(/^[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/, 'encrypted format'),
      otherwise: Joi.string().custom((value, helpers) => {
        if (!validator.isURL(value)) return helpers.error('any.invalid');
        return value;
      }, 'URL validation'),
    })
    .messages({
      'string.pattern.name': 'Text content must be in encrypted format (data|iv|key)',
      'any.invalid': 'Media content must be a valid URL',
    }),
  contentType: Joi.string()
    .valid(...validContentTypes)
    .required()
    .messages({ 'any.only': `contentType must be one of: ${validContentTypes.join(', ')}` }),
  plaintextContent: Joi.string().allow('').optional(),
  caption: Joi.string().optional(),
  replyTo: Joi.string()
    .custom((value, helpers) => {
      if (value && !mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
      return value;
    }, 'ObjectId validation')
    .optional()
    .messages({ 'any.invalid': 'Invalid replyTo ID' }),
  originalFilename: Joi.string().optional(),
  clientMessageId: Joi.string().required().messages({ 'string.empty': 'clientMessageId required' }),
  senderVirtualNumber: Joi.string().optional(),
  senderUsername: Joi.string().optional(),
  senderPhoto: Joi.string().optional(),
});

const addContactSchema = Joi.object({
  userId: Joi.string()
    .custom((value, helpers) => {
      if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
      return value;
    }, 'ObjectId validation')
    .required(),
  virtualNumber: Joi.string().required(),
});

const deleteUserSchema = Joi.object({
  userId: Joi.string()
    .custom((value, helpers) => {
      if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
      return value;
    }, 'ObjectId validation')
    .required(),
});

module.exports = (io, server) => {
  // Socket.IO configuration
  const socketIO = require('socket.io')(server, {
    cors: {
      origin: 'https://gapp-6yc3.onrender.com',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  // Socket.IO middleware for authentication
  socketIO.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const sid = socket.handshake.query?.sid;
    logger.info('Socket.IO connection attempt', { token: token?.substring(0, 10), sid });
    if (!token || typeof token !== 'string') {
      logger.warn('Invalid or missing token for Socket.IO', { token: token?.substring(0, 10), sid });
      return next(new Error('Authentication error: No token provided'));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      socket.user = decoded;
      logger.info('Socket.IO authentication successful', { userId: decoded.id });
      next();
    } catch (err) {
      logger.error('Socket.IO auth error:', { error: err.message, token: token.substring(0, 10) + '...' });
      return next(new Error('Invalid token'));
    }
  });

  const router = express.Router();

  const emitUpdatedChatList = async (userId) => {
    try {
      if (!mongoose.isValidObjectId(userId)) {
        logger.warn('Invalid userId in emitUpdatedChatList', { userId });
        return;
      }
      const contacts = await User.find({ contacts: userId }).select(
        'username virtualNumber photo status lastSeen'
      );

      const contactIds = contacts.map((c) => c._id);
      const latestMessages = await Message.aggregate([
        {
          $match: {
            $or: [
              { senderId: new mongoose.Types.ObjectId(userId), recipientId: { $in: contactIds } },
              { senderId: { $in: contactIds }, recipientId: new mongoose.Types.ObjectId(userId) },
            ],
          },
        },
        {
          $sort: { createdAt: -1 },
        },
        {
          $group: {
            _id: {
              $cond: [
                { $eq: ['$senderId', new mongoose.Types.ObjectId(userId)] },
                '$recipientId',
                '$senderId',
              ],
            },
            latestMessage: { $first: '$$ROOT' },
          },
        },
        {
          $project: {
            _id: 0,
            contactId: '$_id',
            latestMessage: {
              content: 1,
              contentType: 1,
              senderId: 1,
              recipientId: 1,
              createdAt: 1,
              plaintextContent: 1,
              senderVirtualNumber: 1,
              senderUsername: 1,
              senderPhoto: 1,
            },
          },
        },
      ]);

      const unreadCounts = await Message.aggregate([
        {
          $match: {
            senderId: { $in: contactIds },
            recipientId: new mongoose.Types.ObjectId(userId),
            status: { $ne: 'read' },
          },
        },
        {
          $group: {
            _id: '$senderId',
            unreadCount: { $sum: 1 },
          },
        },
      ]);

      const chatList = contacts.map((contact) => {
        const messageData = latestMessages.find(
          (m) => m.contactId.toString() === contact._id.toString()
        );
        const unreadData = unreadCounts.find(
          (u) => u._id.toString() === contact._id.toString()
        );
        return {
          id: contact._id.toString(),
          username: contact.username,
          virtualNumber: contact.virtualNumber,
          photo: contact.photo,
          status: contact.status,
          lastSeen: contact.lastSeen,
          latestMessage: messageData ? messageData.latestMessage : null,
          unreadCount: unreadData ? unreadData.unreadCount : 0,
        };
      });

      socketIO.to(userId).emit('chatListUpdated', { userId, users: chatList });
      await memcached.setex(`:chat-list:${userId}`, 300, JSON.stringify(chatList));
      logger.info('Emitted updated chat list', { userId });
    } catch (error) {
      logger.error('Failed to emit updated chat list', { error: error.message, stack: error.stack, userId });
    }
  };

  socketIO.on('connection', (socket) => {
    logger.info('New Socket.IO connection', { socketId: socket.id });

    socket.on('join', (userId) => {
      if (!mongoose.isValidObjectId(userId)) {
        logger.warn('Invalid userId in join', { userId });
        return;
      }
      socket.join(userId);
      User.findByIdAndUpdate(userId, { status: 'online', lastSeen: new Date() }, { new: true })
        .then((user) => {
          if (user) {
            socketIO.to(userId).emit('userStatus', { userId, status: 'online', lastSeen: user.lastSeen });
            emitUpdatedChatList(userId);
            logger.info('User joined', { userId });
          }
        })
        .catch((err) => {
          logger.error('User join failed', { error: err.message, stack: err.stack, userId });
        });
    });

    socket.on('leave', (userId) => {
      if (!mongoose.isValidObjectId(userId)) {
        logger.warn('Invalid userId in leave', { userId });
        return;
      }
      User.findByIdAndUpdate(userId, { status: 'offline', lastSeen: new Date() }, { new: true })
        .then((user) => {
          if (user) {
            socketIO.to(userId).emit('userStatus', { userId, status: 'offline', lastSeen: user.lastSeen });
            logger.info('User left', { userId });
          }
        })
        .catch((err) => {
          logger.error('User leave failed', { error: err.message, stack: err.stack, userId });
        });
      socket.leave(userId);
    });

    socket.on('typing', ({ userId, recipientId }) => {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId)) {
        logger.warn('Invalid IDs in typing', { userId, recipientId });
        return;
      }
      socketIO.to(recipientId).emit('typing', { userId });
    });

    socket.on('stopTyping', ({ userId, recipientId }) => {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId)) {
        logger.warn('Invalid IDs in stopTyping', { userId, recipientId });
        return;
      }
      socketIO.to(recipientId).emit('stopTyping', { userId });
    });

    socket.on('newContact', ({ userId, contactData }) => {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(contactData.id)) {
        logger.warn('Invalid IDs in newContact', { userId, contactId: contactData.id });
        return;
      }
      User.findById(contactData.id)
        .then((contact) => {
          if (contact) {
            const contactObj = {
              id: contact._id.toString(),
              username: contact.username,
              virtualNumber: contact.virtualNumber,
              photo: contact.photo,
              status: contact.status,
              lastSeen: contact.lastSeen,
            };
            socketIO.to(userId).emit('newContact', { userId, contactData: contactObj });
            socketIO.to(contactData.id).emit('newContact', { userId: contactData.id, contactData: contactObj });
            emitUpdatedChatList(userId);
            emitUpdatedChatList(contactData.id);
            logger.info('New contact emitted', { userId, contactId: contactData.id });
          }
        })
        .catch((err) => {
          logger.error('New contact emission failed', { error: err.message, stack: err.stack, userId, contactId: contactData.id });
        });
    });

    socket.on('chatListUpdated', ({ userId, users }) => {
      if (!mongoose.isValidObjectId(userId)) {
        logger.warn('Invalid userId in chatListUpdated', { userId });
        return;
      }
      socketIO.to(userId).emit('chatListUpdated', { userId, users });
      logger.info('Chat list update propagated', { userId });
    });

    socket.on('message', async (messageData, callback) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const { error } = messageSchema.validate(messageData);
        if (error) {
          logger.warn('Invalid message data', { error: error.details });
          await session.abortTransaction();
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

        logger.info('Processing message', { senderId, recipientId, clientMessageId });

        const sender = await User.findById(senderId).session(session);
        const recipient = await User.findById(recipientId).session(session);
        if (!sender || !recipient) {
          logger.warn('Sender or recipient not found', { senderId, recipientId });
          await session.abortTransaction();
          return callback({ error: 'Sender or recipient not found' });
        }

        const existingMessage = await Message.findOne({ clientMessageId }).session(session);
        if (existingMessage) {
          logger.info('Duplicate message found', { clientMessageId });
          await session.commitTransaction();
          return callback({ message: existingMessage.toObject() });
        }

        const message = new Message({
          senderId,
          recipientId,
          content,
          contentType,
          plaintextContent: plaintextContent || '',
          status: 'sent',
          caption: caption || undefined,
          replyTo: replyTo && mongoose.isValidObjectId(replyTo) ? replyTo : undefined,
          originalFilename: messageData.originalFilename || undefined,
          clientMessageId,
          senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
          senderUsername: senderUsername || sender.username,
          senderPhoto: senderPhoto || sender.photo,
        });

        await message.save({ session });

        const populatedMessage = await Message.findById(message._id)
          .session(session)
          .populate('senderId', 'username virtualNumber photo')
          .populate('recipientId', 'username virtualNumber photo')
          .populate('replyTo', 'content contentType senderId recipientId createdAt');

        await session.commitTransaction();

        logger.info('Emitting message', {
          messageId: populatedMessage._id,
          senderId: populatedMessage.senderId,
          recipientId: populatedMessage.recipientId,
          clientMessageId,
        });

        socketIO.to(recipientId).emit('message', populatedMessage.toObject());
        socketIO.to(senderId).emit('message', populatedMessage.toObject());

        await memcached.setex(`:message:${clientMessageId}`, 3600, JSON.stringify(populatedMessage.toObject()));
        await memcached.del(`:chat-list:${senderId}`);
        await memcached.del(`:chat-list:${recipientId}`);

        emitUpdatedChatList(senderId);
        emitUpdatedChatList(recipientId);

        logger.info('Message sent successfully', { messageId: message._id, clientMessageId, senderId, recipientId });

        callback({ message: populatedMessage.toObject() });
      } catch (err) {
        await session.abortTransaction();
        logger.error('Message send failed', { error: err.message, stack: err.stack, clientMessageId: messageData.clientMessageId });
        callback({ error: err.message });
      } finally {
        session.endSession();
      }
    });

    socket.on('editMessage', async ({ messageId, newContent, plaintextContent }, callback) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        if (!mongoose.isValidObjectId(messageId)) {
          logger.warn('Invalid messageId in editMessage', { messageId });
          await session.abortTransaction();
          return callback({ error: 'Invalid messageId' });
        }

        const message = await Message.findById(messageId).session(session);
        if (!message) {
          logger.warn('Message not found for edit', { messageId });
          await session.abortTransaction();
          return callback({ error: 'Message not found' });
        }

        message.content = newContent;
        message.plaintextContent = plaintextContent || '';
        message.updatedAt = new Date();
        await message.save({ session });

        const populatedMessage = await Message.findById(message._id)
          .session(session)
          .populate('senderId', 'username virtualNumber photo')
          .populate('recipientId', 'username virtualNumber photo')
          .populate('replyTo', 'content contentType senderId recipientId createdAt');

        await session.commitTransaction();

        socketIO.to(message.recipientId.toString()).emit('editMessage', populatedMessage.toObject());
        socketIO.to(message.senderId.toString()).emit('editMessage', populatedMessage.toObject());

        await memcached.setex(`:message:${message.clientMessageId}`, 3600, JSON.stringify(populatedMessage.toObject()));
        await memcached.del(`:chat-list:${message.senderId}`);
        await memcached.del(`:chat-list:${message.recipientId}`);

        logger.info('Message edited successfully', { messageId });

        callback({ message: populatedMessage.toObject() });
      } catch (err) {
        await session.abortTransaction();
        logger.error('Edit message failed', { error: err.message, stack: err.stack, messageId });
        callback({ error: err.message });
      } finally {
        session.endSession();
      }
    });

    socket.on('deleteMessage', async ({ messageId, recipientId }, callback) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        if (!mongoose.isValidObjectId(messageId) || !mongoose.isValidObjectId(recipientId)) {
          logger.warn('Invalid IDs in deleteMessage', { messageId, recipientId });
          await session.abortTransaction();
          return callback({ error: 'Invalid messageId or recipientId' });
        }

        const message = await Message.findById(messageId).session(session);
        if (!message) {
          logger.warn('Message not found for delete', { messageId });
          await session.abortTransaction();
          return callback({ error: 'Message not found' });
        }

        await Message.findByIdAndDelete(messageId, { session });

        await session.commitTransaction();

        socketIO.to(recipientId).emit('deleteMessage', { messageId, recipientId });
        socketIO.to(message.senderId.toString()).emit('deleteMessage', { messageId, recipientId: message.senderId.toString() });

        await memcached.del(`:message:${message.clientMessageId}`);
        await memcached.del(`:chat-list:${message.senderId}`);
        await memcached.del(`:chat-list:${message.recipientId}`);

        emitUpdatedChatList(message.senderId.toString());
        emitUpdatedChatList(recipientId);

        logger.info('Message deleted successfully', { messageId, recipientId });

        callback({});
      } catch (err) {
        await session.abortTransaction();
        logger.error('Delete message failed', { error: err.message, stack: err.stack, messageId, recipientId });
        callback({ error: err.message });
      } finally {
        session.endSession();
      }
    });

    socket.on('messageStatus', async ({ messageId, status }) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        if (!mongoose.isValidObjectId(messageId)) {
          logger.warn('Invalid messageId in messageStatus', { messageId });
          await session.abortTransaction();
          return;
        }

        const message = await Message.findById(messageId).session(session);
        if (!message || !['sent', 'delivered', 'read'].includes(status)) {
          logger.warn('Invalid message or status', { messageId, status });
          await session.abortTransaction();
          return;
        }

        message.status = status;
        await message.save({ session });

        await session.commitTransaction();

        socketIO.to(message.senderId.toString()).emit('messageStatus', { messageId, status });

        await memcached.setex(`:message:${message.clientMessageId}`, 3600, JSON.stringify(message.toObject()));

        logger.info('Message status updated', { messageId, status });
      } catch (err) {
        await session.abortTransaction();
        logger.error('Message status update failed', { error: err.message, stack: err.stack, messageId });
      } finally {
        session.endSession();
      }
    });

    socket.on('batchMessageStatus', async ({ messageIds, status, recipientId }) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        if (!messageIds.every((id) => mongoose.isValidObjectId(id)) || !mongoose.isValidObjectId(recipientId)) {
          logger.warn('Invalid IDs in batchMessageStatus', { messageIds, recipientId });
          await session.abortTransaction();
          return;
        }

        const messages = await Message.find({ _id: { $in: messageIds }, recipientId }).session(session);
        if (!messages.length) {
          logger.warn('No messages found for batch status update', { messageIds });
          await session.abortTransaction();
          return;
        }

        await Message.updateMany(
          { _id: { $in: messageIds }, recipientId },
          { status, updatedAt: new Date() },
          { session }
        );

        await session.commitTransaction();

        const senderIds = [...new Set(messages.map((msg) => msg.senderId.toString()))];
        senderIds.forEach((senderId) => {
          socketIO.to(senderId).emit('messageStatus', { messageIds, status });
        });

        for (const message of messages) {
          await memcached.setex(`:message:${message.clientMessageId}`, 3600, JSON.stringify(message.toObject()));
        }

        logger.info('Batch message status updated', { messageIds, status, recipientId });
      } catch (err) {
        await session.abortTransaction();
        logger.error('Batch message status update failed', { error: err.message, stack: err.stack, messageIds });
      } finally {
        session.endSession();
      }
    });

    socket.on('disconnect', (reason) => {
      logger.info('Socket.IO disconnected', { socketId: socket.id, reason });
    });
  });

  router.get('/health', async (req, res) => {
    try {
      await memcached.get('health-check');
      res.json({ status: 'healthy', memcached: 'up' });
    } catch (err) {
      logger.error('Memcached health check failed', { error: err.message });
      res.status(503).json({ status: 'unhealthy', memcached: 'down' });
    }
  });

  router.get('/chat-list', authMiddleware, async (req, res) => {
    const { userId } = req.query;
    try {
      if (!mongoose.isValidObjectId(userId)) {
        logger.warn('Invalid userId in chat-list', { userId });
        return res.status(400).json({ error: 'Invalid userId' });
      }

      const cacheKey = `:chat-list:${userId}`;
      const cachedChatList = await memcached.get(cacheKey);
      if (cachedChatList) {
        logger.info('Chat list served from cache', { userId });
        return res.json(JSON.parse(cachedChatList));
      }

      const contacts = await User.find({ contacts: userId }).select(
        'username virtualNumber photo status lastSeen'
      );

      const contactIds = contacts.map((c) => c._id);
      const latestMessages = await Message.aggregate([
        {
          $match: {
            $or: [
              { senderId: new mongoose.Types.ObjectId(userId), recipientId: { $in: contactIds } },
              { senderId: { $in: contactIds }, recipientId: new mongoose.Types.ObjectId(userId) },
            ],
          },
        },
        {
          $sort: { createdAt: -1 },
        },
        {
          $group: {
            _id: {
              $cond: [
                { $eq: ['$senderId', new mongoose.Types.ObjectId(userId)] },
                '$recipientId',
                '$senderId',
              ],
            },
            latestMessage: { $first: '$$ROOT' },
          },
        },
        {
          $project: {
            _id: 0,
            contactId: '$_id',
            latestMessage: {
              content: 1,
              contentType: 1,
              senderId: 1,
              recipientId: 1,
              createdAt: 1,
              plaintextContent: 1,
              senderVirtualNumber: 1,
              senderUsername: 1,
              senderPhoto: 1,
            },
          },
        },
      ]);

      const unreadCounts = await Message.aggregate([
        {
          $match: {
            senderId: { $in: contactIds },
            recipientId: new mongoose.Types.ObjectId(userId),
            status: { $ne: 'read' },
          },
        },
        {
          $group: {
            _id: '$senderId',
            unreadCount: { $sum: 1 },
          },
        },
      ]);

      const chatList = contacts.map((contact) => {
        const messageData = latestMessages.find(
          (m) => m.contactId.toString() === contact._id.toString()
        );
        const unreadData = unreadCounts.find(
          (u) => u._id.toString() === contact._id.toString()
        );
        return {
          id: contact._id.toString(),
          username: contact.username,
          virtualNumber: contact.virtualNumber,
          photo: contact.photo,
          status: contact.status,
          lastSeen: contact.lastSeen,
          latestMessage: messageData ? messageData.latestMessage : null,
          unreadCount: unreadData ? unreadData.unreadCount : 0,
        };
      });

      await memcached.setex(cacheKey, 300, JSON.stringify(chatList));
      logger.info('Chat list fetched', { userId });

      res.json(chatList);
    } catch (err) {
      logger.error('Chat list fetch failed', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/messages', authMiddleware, async (req, res) => {
    const { userId, recipientId, limit = 50, skip = 0 } = req.query;
    try {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId)) {
        logger.warn('Invalid IDs in messages', { userId, recipientId });
        return res.status(400).json({ error: 'Invalid userId or recipientId' });
      }

      const cacheKey = `:messages:${userId}:${recipientId}:${limit}:${skip}`;
      const cachedMessages = await memcached.get(cacheKey);
      if (cachedMessages) {
        logger.info('Messages served from cache', { userId, recipientId });
        return res.json(JSON.parse(cachedMessages));
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
        .populate('senderId', 'username virtualNumber photo')
        .populate('recipientId', 'username virtualNumber photo')
        .populate('replyTo', 'content contentType senderId recipientId createdAt');

      const response = {
        messages: messages.map((msg) => msg.toObject()).reverse(),
        total: await Message.countDocuments({
          $or: [
            { senderId: userId, recipientId },
            { senderId: recipientId, recipientId: userId },
          ],
        }),
      };

      await memcached.setex(cacheKey, 300, JSON.stringify(response));
      logger.info('Messages fetched', { userId, recipientId, count: messages.length });

      res.json(response);
    } catch (err) {
      logger.error('Messages fetch failed', { error: err.message, stack: err.stack, userId, recipientId });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/add_contact', authMiddleware, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { error } = addContactSchema.validate(req.body);
      if (error) {
        logger.warn('Invalid add contact request', { error: error.details });
        await session.abortTransaction();
        return res.status(400).json({ error: error.details[0].message });
      }

      const { userId, virtualNumber } = req.body;
      const user = await User.findById(userId).session(session);
      if (!user) {
        logger.warn('User not found for add contact', { userId });
        await session.abortTransaction();
        return res.status(404).json({ error: 'User not found' });
      }

      const contact = await User.findOne({ virtualNumber }).session(session);
      if (!contact) {
        logger.warn('Contact not found', { virtualNumber });
        await session.abortTransaction();
        return res.status(400).json({ error: 'Contact not found' });
      }

      if (contact._id.toString() === userId) {
        logger.warn('Cannot add self as contact', { userId });
        await session.abortTransaction();
        return res.status(400).json({ error: 'Cannot add yourself as a contact' });
      }

      if (user.contacts.includes(contact._id)) {
        logger.info('Contact already exists', { userId, contactId: contact._id });
        await session.commitTransaction();
        return res.status(400).json({ error: 'Contact already exists' });
      }

      user.contacts.push(contact._id);
      if (!contact.contacts.includes(user._id)) {
        contact.contacts.push(user._id);
      }
      await user.save({ session });
      await contact.save({ session });

      await session.commitTransaction();

      const contactData = {
        id: contact._id.toString(),
        username: contact.username,
        virtualNumber: contact.virtualNumber,
        photo: contact.photo,
        status: contact.status,
        lastSeen: contact.lastSeen,
      };

      socketIO.to(userId).emit('newContact', { userId, contactData });
      socketIO.to(contact._id.toString()).emit('newContact', { userId: contact._id.toString(), contactData });

      await memcached.del(`:chat-list:${userId}`);
      await memcached.del(`:chat-list:${contact._id}`);
      await memcached.del(`:contacts:${userId}`);
      await memcached.del(`:contacts:${contact._id}`);

      emitUpdatedChatList(userId);
      emitUpdatedChatList(contact._id.toString());

      logger.info('Contact added', { userId, contactId: contact._id });

      res.json(contactData);
    } catch (err) {
      await session.abortTransaction();
      logger.error('Add contact failed', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: err.message });
    } finally {
      session.endSession();
    }
  });

  router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { userId, recipientId, clientMessageId, senderVirtualNumber, senderUsername, senderPhoto, caption } = req.body;
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId) || !clientMessageId || !req.file) {
        logger.warn('Invalid upload parameters', { userId, recipientId, clientMessageId });
        await session.abortTransaction();
        return res.status(400).json({ error: 'Invalid parameters' });
      }

      const sender = await User.findById(userId).session(session);
      const recipient = await User.findById(recipientId).session(session);
      if (!sender || !recipient) {
        logger.warn('Sender or recipient not found', { userId, recipientId });
        await session.abortTransaction();
        return res.status(400).json({ error: 'Sender or recipient not found' });
      }

      const existingMessage = await Message.findOne({ clientMessageId }).session(session);
      if (existingMessage) {
        logger.info('Duplicate upload message', { clientMessageId });
        await session.commitTransaction();
        return res.json({ message: existingMessage.toObject() });
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

      const message = new Message({
        senderId: userId,
        recipientId,
        content: uploadResult.secure_url,
        contentType,
        status: 'sent',
        caption: caption || undefined,
        originalFilename: req.file.originalname,
        clientMessageId,
        senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
        senderUsername: senderUsername || sender.username,
        senderPhoto: senderPhoto || sender.photo,
      });

      await message.save({ session });

      const populatedMessage = await Message.findById(message._id)
        .session(session)
        .populate('senderId', 'username virtualNumber photo')
        .populate('recipientId', 'username virtualNumber photo')
        .populate('replyTo', 'content contentType senderId recipientId createdAt');

      await session.commitTransaction();

      socketIO.to(recipientId).emit('message', populatedMessage.toObject());
      socketIO.to(userId).emit('message', populatedMessage.toObject());

      await memcached.setex(`:message:${clientMessageId}`, 3600, JSON.stringify(populatedMessage.toObject()));
      await memcached.del(`:chat-list:${userId}`);
      await memcached.del(`:chat-list:${recipientId}`);

      emitUpdatedChatList(userId);
      emitUpdatedChatList(recipientId);

      logger.info('Media uploaded and message sent', { messageId: message._id, clientMessageId });

      res.json({ message: populatedMessage.toObject() });
    } catch (err) {
      await session.abortTransaction();
      logger.error('Media upload failed', { error: err.message, stack: err.stack, clientMessageId: req.body.clientMessageId });
      res.status(500).json({ error: err.message });
    } finally {
      session.endSession();
    }
  });

  router.post('/delete_user', authMiddleware, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { error } = deleteUserSchema.validate(req.body);
      if (error) {
        logger.warn('Invalid delete user request', { error: error.details });
        await session.abortTransaction();
        return res.status(400).json({ error: error.details[0].message });
      }

      const { userId } = req.body;
      const user = await User.findById(userId).session(session);
      if (!user) {
        logger.warn('User not found for deletion', { userId });
        await session.abortTransaction();
        return res.status(404).json({ error: 'User not found' });
      }

      const contacts = await User.find({ contacts: userId }).select('_id').session(session);
      const contactIds = contacts.map((contact) => contact._id.toString());

      await Message.deleteMany(
        { $or: [{ senderId: userId }, { recipientId: userId }] },
        { session }
      );

      await User.updateMany(
        { contacts: userId },
        { $pull: { contacts: userId } },
        { session }
      );

      await User.findByIdAndDelete(userId, { session });

      await session.commitTransaction();

      socketIO.to(userId).emit('userStatus', { userId, status: 'offline', lastSeen: new Date() });
      socketIO.to(contactIds).emit('userDeleted', { userId });

      await memcached.del(`:chat-list:${userId}`);
      await memcached.del(`:contacts:${userId}`);
      for (const contactId of contactIds) {
        await memcached.del(`:chat-list:${contactId}`);
        await memcached.del(`:contacts:${contactId}`);
        emitUpdatedChatList(contactId);
      }

      logger.info('User deleted', { userId });

      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      await session.abortTransaction();
      logger.error('User deletion failed', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: err.message });
    } finally {
      session.endSession();
    }
  });

  return router;
};