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

module.exports = (io) => {
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

      io.to(userId).emit('chatListUpdated', { userId, users: chatList });
      logger.info('Emitted updated chat list', { userId });
    } catch (error) {
      logger.error('Failed to emit updated chat list', { error: error.message, stack: error.stack, userId });
    }
  };

  io.on('connection', (socket) => {
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
            io.to(userId).emit('userStatus', { userId, status: 'online', lastSeen: user.lastSeen });
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
            io.to(userId).emit('userStatus', { userId, status: 'offline', lastSeen: user.lastSeen });
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
      io.to(recipientId).emit('typing', { userId });
    });

    socket.on('stopTyping', ({ userId, recipientId }) => {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId)) {
        logger.warn('Invalid IDs in stopTyping', { userId, recipientId });
        return;
      }
      io.to(recipientId).emit('stopTyping', { userId });
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
            io.to(userId).emit('newContact', { userId, contactData: contactObj });
            io.to(contactData.id).emit('newContact', { userId: contactData.id, contactData: contactObj });
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
      io.to(userId).emit('chatListUpdated', { userId, users });
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

        io.to(recipientId).emit('message', populatedMessage.toObject());
        io.to(senderId).emit('message', populatedMessage.toObject());

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

        io.to(message.recipientId.toString()).emit('editMessage', populatedMessage.toObject());
        io.to(message.senderId.toString()).emit('editMessage', populatedMessage.toObject());

        logger.info('Message edited successfully', { messageId });

        callback({ message: populatedMessage.toObject() });
      } catch (err) {
        await session.abortTransaction();
        logger.error('Edit message failed', { error: err.message, stack: err.stack });
        callback({ error: 'Failed to edit message' });
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

        await Message.findByIdAndDelete(messageId).session({ session });
        await session.commitTransaction();

        io.to(recipientId).emit('deleteMessage', { messageId, recipientId });
        io.to(message.senderId.toString()).emit('deleteMessage', { messageId, recipientId: message.senderId.toString() });

        emitUpdatedChatList(message.senderId.toString());
        emitUpdatedChatList(recipientId);

        logger.info('Message deleted successfully', { messageId, recipientId });
        callback({ status: 'success' });
      } catch (err) {
        await session.abortTransaction();
        logger.error('Delete message failed', { error: err.message, stack: err.stack, messageId, recipientId });
        callback({ error: 'Failed to delete message' });
      } finally {
        session.endSession();
      }
    });

    socket.on('messageStatus', async ({ messageId, status }) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        if (!mongoose.isValidObjectId(messageId)) {
          logger.warn('Invalid messageId in messageStatus', { messageId: messageId });
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

        io.to(message.senderId.toString()).emit('messageStatus', { messageId, status });

        logger.info('Message status updated', { messageId, status });
      } catch (err) {
        await session.abortTransaction();
        logger.error('Message status update failed', { error: err.message, stack: err.stack });
        callback({ error: 'Failed to update message status' });
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

        const messages = await Message.find({ _id: { $in: messageIds }, recipientId}).session(session);
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
          io.toString(senderId).emit('messageStatus', { messageIds, status });
        });

        logger.info('Batch message status updated', { messageIds, status, ids: messageIds.length });
      } catch (err) {
        await session.abortTransaction();
        logger.error('Batch message status update failed', { error: messageIds, stack: err.stack });
        callback({ error: 'Failed to update batch message status' });
      } finally {
        session.endSession();
      };
    });

    socket.on('disconnect', () => {
      logger.info('Socket.IO disconnected', { socketId: socket.id });
    });
  });

  router.get('/health', async (req, res) => {
    res.json({ status: 'healthy' });
  });

  router.post('/messages', authMiddleware, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { error } = messageSchema.validate(req.body);
      if (error) {
        logger.warn('Invalid message data', { error: error.details });
        await session.endSession();
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

      const sender = await User.findById(senderId).session(session);
      const recipient = await User.findById(recipientId).session(session);
      if (!sender || !recipient) {
        logger.warn('Sender or recipient not found', { senderId, recipientId });
        await session.abortTransaction();
        return res.status(400).json({ error: 'Sender or recipient not found' });
      }

      const existingMessage = await Message.findOne({ clientMessageId }).session(session);
      if (existingMessage) {
        logger.info('Duplicate message found', { clientMessageId });
        await session.commitTransaction();
        return res.status(200).json({ message: existingMessage.toObject() });
      }

      const message = new Message({
        senderId,
        recipientId,
        content,
        contentType,
        plaintextContent: plaintextContent || '',
        status: 'sent',
        caption: caption || '',
        replyTo: replyTo && mongoose.isValidObjectId(replyTo) ? replyTo : undefined,
        originalFilename: req.body.originalFilename || undefined,
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

      io.to(recipientId).emit('message', populatedMessage.toObject());
      io.to(senderId).emit('message', populatedMessage.toObject());

      emitUpdatedChatList(senderId);
      emitUpdatedChatList(recipientId);

      logger.info('Message saved', { messageId: message._id, clientMessageId });
      res.status(201).json({ message: populatedMessage.toObject() });
    } catch (error) {
      await session.abortTransaction();
      logger.error('Save message error:', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to save message', details: error.message });
    } finally {
      session.endSession();
    }
  });

  router.get('/chat-list', authMiddleware, async (req, res) => {
    const { userId } = req.query;
    try {
      if (!mongoose.isValidObjectId(userId)) {
        logger.warn('Invalid userId in chat-list', { userId });
        return res.status(400).json({ error: 'Invalid userId' });
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

      logger.info('Chat list fetched', { userId });
      res.json(chatList);
    } catch (err) {
      logger.error('Chat list failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to fetch chat list' });
    }
  });

  router.get('/messages', authMiddleware, async (req, res) => {
    const { userId, recipientId, limit = 50, skip = 0 } = req.query;
    try {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId)) {
        logger.warn('Invalid IDs in messages', { userId, recipientId });
        return res.status(400).json({ error: 'Invalid userId or recipientId' });
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
        .populate('replyTo', 'content contentType senderId recipientId createdAt');

      const total = await Message.countDocuments({
        $or: [
          { senderId: userId, recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      });

      logger.info('Messages fetched', { userId, recipientId, count: messages.length });
      res.json({ messages, total });
    } catch (err) {
      logger.error('Messages fetch failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  




  router.post('/add_contact', authMiddleware, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { error } = addContactSchema.validate(req.body);
    if (error) {
      logger.warn('Invalid add contact data', { error: error.details });
      await session.abortTransaction();
      return res.status(400).json({ error: error.details[0].message });
    }

    const { userId, virtualNumber } = req.body;
    const user = await User.findById(userId).session(session);
    if (!user) {
      logger.warn('User not found', { userId });
      await session.abortTransaction();
      return res.status(404).json({ error: 'User not found' });
    }

    const contact = await User.findOne({ virtualNumber }).session(session);
    if (!contact) {
      logger.warn('Contact not found', { virtualNumber });
      await session.abortTransaction();
      return res.status(404).json({ error: 'Contact not found' });
    }

    if (contact._id.toString() === userId) {
      logger.warn('Cannot add self as contact', { userId });
      await session.abortTransaction();
      return res.status(400).json({ error: 'Cannot add self as contact' });
    }

    const userUpdate = user.contacts.includes(contact._id)
      ? {}
      : { $push: { contacts: contact._id } };
    const contactUpdate = contact.contacts.includes(user._id)
      ? {}
      : { $push: { contacts: user._id } };

    if (Object.keys(userUpdate).length) {
      user.contacts.push(contact._id);
      await user.save({ session });
    }
    if (Object.keys(contactUpdate).length) {
      contact.contacts.push(user._id);
      await contact.save({ session });
    }

    if (!Object.keys(userUpdate).length && !Object.keys(contactUpdate).length) {
      logger.info('Contact already exists', { userId, contactId: contact._id });
      await session.commitTransaction();
      return res.status(200).json({
        id: contact._id.toString(),
        username: contact.username,
        virtualNumber: contact.virtualNumber,
        photo: contact.photo,
        status: contact.status,
        lastSeen: contact.lastSeen,
      });
    }

    await session.commitTransaction();

    const contactData = {
      id: contact._id.toString(),
      username: contact.username,
      virtualNumber: contact.virtualNumber,
      photo: contact.photo || 'https://placehold.co/40x40',
      status: contact.status,
      lastSeen: contact.lastSeen,
    };

    io.to(userId).emit('newContact', { userId, contactData });
    io.to(contact._id.toString()).emit('newContact', {
      userId: contact._id.toString(),
      contactData: {
        id: user._id.toString(),
        username: user.username,
        virtualNumber: user.virtualNumber,
        photo: user.photo || 'https://placehold.co/40x40',
        status: user.status,
        lastSeen: user.lastSeen,
      },
    });

    emitUpdatedChatList(userId);
    emitUpdatedChatList(contact._id.toString());

    logger.info('Contact added', { userId, contactId: contact._id });
    res.json(contactData);
  } catch (err) {
    await session.abortTransaction();
    logger.error('Add contact failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to add contact' });
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

      io.to(recipientId).emit('message', populatedMessage.toObject());
      io.to(userId).emit('message', populatedMessage.toObject());

      emitUpdatedChatList(userId);
      emitUpdatedChatList(recipientId);

      logger.info('Media uploaded', { messageId: message._id, clientMessageId });
      res.json({ message: populatedMessage.toObject() });
    } catch (err) {
      await session.abortTransaction();
      logger.error('Media upload failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to upload media' });
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
        logger.warn('Invalid delete user data', { error: error.details });
        await session.abortTransaction();
        return res.status(400).json({ error: error.details[0].message });
      }

      const { userId } = req.body;
      const user = await User.findById(userId).session(session);
      if (!user) {
        logger.warn('User not found', { userId });
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

      io.to(userId).emit('userStatus', { userId, status: 'offline', lastSeen: new Date() });
      io.to(contactIds).emit('userDeleted', { userId });

      for (const contactId of contactIds) {
        emitUpdatedChatList(contactId);
      }

      logger.info('User deleted', { userId });
      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      await session.abortTransaction();
      logger.error('User deletion failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to delete user' });
    } finally {
      session.endSession();
    }
  });

  return router;
};