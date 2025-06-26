const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const winston = require('winston');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { authMiddleware } = require('./auth');
const Message = require('../models/Message');
const TokenBlacklist = require('../models/TokenBlacklist');
const router = express.Router();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
    winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/social-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/social-combined.log' }),
  ],
});

// Error deduplication
const errorLogMap = new Map();
const maxLogsPerMinute = 5;
const logError = (message, metadata = {}) => {
  const now = Date.now();
  const errorEntry = errorLogMap.get(message) || { count: 0, timestamps: [] };
  errorEntry.timestamps = errorEntry.timestamps.filter((ts) => now - ts < 60 * 1000);
  if (errorEntry.count >= 1 || errorEntry.timestamps.length >= maxLogsPerMinute) {
    logger.warn(`Error logging skipped for "${message}": rate limit reached`);
    return;
  }
  errorEntry.count += 1;
  errorEntry.timestamps.push(now);
  errorLogMap.set(message, errorEntry);
  logger.error(message, metadata);
};

// Configure Cloudinary with retry logic
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
      logError('Invalid CLOUDINARY_URL format', { error: err.message });
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
    logError('Cloudinary configuration missing');
    throw new Error('Cloudinary configuration missing');
  }
  cloudinary.config({ ...cloudinaryConfig, secure: true, timeout: 15000 });
  logger.info('Cloudinary configured', { cloud_name: cloudinaryConfig.cloud_name });
};
configureCloudinary();

// Multer with optimized memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/', 'video/', 'audio/', 'application/'];
    if (allowedTypes.some((type) => file.mimetype.startsWith(type))) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  },
});

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: 'Too many requests, please try again later',
});

// Stricter rate limiters
const addContactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many contact addition requests, please try again later',
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many upload requests, please try again later',
});
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  message: 'Too many message requests, please try again later',
});

const validContentTypes = ['text', 'image', 'video', 'audio', 'document'];

// Joi schemas
const messageSchema = Joi.object({
  senderId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }).required(),
  recipientId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }).required(),
  content: Joi.string().allow('').required(),
  contentType: Joi.string().valid(...validContentTypes).required(),
  plaintextContent: Joi.string().allow('').optional(),
  caption: Joi.string().max(500).optional(),
  replyTo: Joi.string().custom((value, helpers) => {
    if (value && !mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }).optional(),
  originalFilename: Joi.string().max(255).optional(),
  clientMessageId: Joi.string().required(),
  senderVirtualNumber: Joi.string().pattern(/^\+\d{7,15}$/).optional(),
  senderUsername: Joi.string().max(50).optional(),
  senderPhoto: Joi.string().uri().optional(),
}).unknown(false);

const addContactSchema = Joi.object({
  userId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }).required(),
  virtualNumber: Joi.string().pattern(/^\+\d{7,15}$/).required(),
});

const editMessageSchema = Joi.object({
  messageId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }).required(),
  newContent: Joi.string().allow('').required(),
  plaintextContent: Joi.string().allow('').optional(),
});

const deleteMessageSchema = Joi.object({
  messageId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }).required(),
  recipientId: Joi.string().custom((value, helpers) => {
    if (!mongoose.isValidObjectId(value)) return helpers.error('any.invalid');
    return value;
  }).required(),
});

// Bounded LRU cache
class LRUCache {
  constructor(maxSize, ttl) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
  }
  get(key) {
    const item = this.cache.get(key);
    if (item && item.timestamp > Date.now() - this.ttl) {
      this.cache.delete(key);
      this.cache.set(key, item);
      return item.data;
    }
    this.cache.delete(key);
    return null;
  }
  set(key, data) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }
  delete(key) {
    this.cache.delete(key);
  }
}

const chatListCache = new LRUCache(1000, 5 * 60 * 1000);

// Retry with exponential backoff
const retryOperation = async (operation, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt === maxRetries) {
        logError('Operation failed after max retries', { error: err.message, attempt });
        throw err;
      }
      const delay = Math.pow(2, attempt) * 1000 * (1 + Math.random() * 0.1);
      logger.warn('Retrying operation', { attempt, error: err.message });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Optimized emitUpdatedChatList with pagination and debouncing
const emitUpdatedChatList = async (io, userId, page = 0, limit = 50) => {
  try {
    if (!mongoose.isValidObjectId(userId)) {
      logError('Invalid userId for chat list emission', { userId });
      return;
    }
    const cacheKey = `chatList:${userId}:${page}:${limit}`;
    const cached = chatListCache.get(cacheKey);
    if (cached) {
      io.to(userId).emit('chatListUpdated', { userId, users: cached, page, limit });
      logger.info('Served cached chat list', { userId, page, count: cached.length });
      return;
    }
    const user = await User.findById(userId)
      .select('contacts')
      .populate({
        path: 'contacts',
        select: 'username virtualNumber photo status lastSeen',
        options: { skip: page * limit, limit, sort: { lastSeen: -1 } },
      })
      .lean();
    if (!user?.contacts?.length) {
      io.to(userId).emit('chatListUpdated', { userId, users: [], page, limit });
      chatListCache.set(cacheKey, []);
      return;
    }
    const contactIds = user.contacts.map((c) => c._id);
    const latestMessages = await Message.aggregate([
      {
        $match: {
          $or: [
            { senderId: new mongoose.Types.ObjectId(userId), recipientId: { $in: contactIds } },
            { recipientId: new mongoose.Types.ObjectId(userId), senderId: { $in: contactIds } },
          ],
        },
      },
      { $sort: { createdAt: -1 } },
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
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$recipientId', new mongoose.Types.ObjectId(userId)] }, { $eq: ['$status', 'delivered'] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    const chatList = user.contacts.map((contact) => {
      const messageData = latestMessages.find((m) => m._id.toString() === contact._id.toString());
      return {
        id: contact._id.toString(),
        username: contact.username || 'Unknown',
        virtualNumber: contact.virtualNumber || '',
        photo: contact.photo || 'https://placehold.co/40x40',
        status: contact.status || 'offline',
        lastSeen: contact.lastSeen || null,
        latestMessage: messageData?.latestMessage
          ? {
              ...messageData.latestMessage,
              senderId: messageData.latestMessage.senderId.toString(),
              recipientId: messageData.latestMessage.recipientId.toString(),
            }
          : null,
        unreadCount: messageData?.unreadCount || 0,
      };
    });
    chatListCache.set(cacheKey, chatList);
    io.to(userId).emit('chatListUpdated', { userId, users: chatList, page, limit });
    logger.info('Emitted updated chat list', { userId, page, count: chatList.length });
  } catch (error) {
    logError('Failed to emit chat list', { error: error.message, userId });
  }
};

// Request duration logging middleware
router.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Request processed', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration,
      userId: req.user?._id?.toString() || 'unauthenticated',
    });
  });
  next();
});

// Apply global rate limiter
router.use(globalLimiter);

// Socket.IO setup
module.exports = (app) => {
  const io = app.get('io');
  if (!io || typeof io.use !== 'function') {
    logError('Invalid Socket.IO instance');
    throw new Error('Socket.IO initialization failed');
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token provided'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      const user = await User.findById(decoded.userId || decoded.id).select('_id').lean();
      if (!user) return next(new Error('User not found'));
      const blacklisted = await TokenBlacklist.findOne({ token }).lean();
      if (blacklisted) return next(new Error('Token invalidated'));
      socket.user = decoded;
      next();
    } catch (error) {
      logError('Socket.IO auth error', { error: error.message });
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    logger.info('Socket.IO connection', { socketId: socket.id, userId: socket.user?.id });

    socket.on('join', async (userId) => {
      if (!mongoose.isValidObjectId(userId) || userId !== socket.user.id) {
        socket.emit('error', { message: 'Invalid join attempt' });
        return;
      }
      socket.join(userId);
      await retryOperation(async () => {
        const user = await User.findByIdAndUpdate(
          userId,
          { status: 'online', lastSeen: new Date() },
          { new: true }
        ).lean();
        io.to(userId).emit('userStatus', { userId, status: 'online', lastSeen: new Date() });
        await emitUpdatedChatList(io, userId);
        const pendingMessages = await Message.find({
          recipientId: userId,
          status: { $in: ['pending', 'sent'] },
        })
          .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
          .lean();
        const messageUpdates = pendingMessages.map(async (msg) => {
          io.to(userId).emit('message', {
            ...msg,
            senderId: msg.senderId.toString(),
            recipientId: msg.recipientId.toString(),
          });
          await Message.updateOne({ _id: msg._id }, { status: 'delivered', updatedAt: new Date() });
          io.to(msg.senderId.toString()).emit('messageStatus', { messageIds: [msg._id], status: 'delivered' });
        });
        await Promise.all(messageUpdates);
      });
      logger.info('User joined', { userId });
    });

    socket.on('reconnect', async (userId) => {
      if (!mongoose.isValidObjectId(userId) || userId !== socket.user.id) {
        socket.emit('error', { message: 'Invalid reconnect attempt' });
        return;
      }
      socket.join(userId);
      await retryOperation(async () => {
        await User.findByIdAndUpdate(userId, { status: 'online', lastSeen: new Date() }, { new: true }).lean();
        io.to(userId).emit('userStatus', { userId, status: 'online', lastSeen: new Date() });
        await emitUpdatedChatList(io, userId);
      });
      logger.info('User reconnected', { userId });
    });

    socket.on('leave', async (userId) => {
      if (!mongoose.isValidObjectId(userId) || userId !== socket.user.id) {
        socket.emit('error', { message: 'Invalid leave attempt' });
        return;
      }
      socket.leave(userId);
      await User.findByIdAndUpdate(userId, { status: 'offline', lastSeen: new Date() });
      io.to(userId).emit('userStatus', { userId, status: 'offline', lastSeen: new Date() });
      logger.info('User left', { userId });
    });

    socket.on('typing', ({ userId, recipientId }) => {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId) || userId !== socket.user.id) {
        socket.emit('error', { message: 'Invalid typing event' });
        return;
      }
      io.to(recipientId).emit('typing', { userId });
    });

    socket.on('stopTyping', ({ userId, recipientId }) => {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId) || userId !== socket.user.id) {
        socket.emit('error', { message: 'Invalid stopTyping event' });
        return;
      }
      io.to(recipientId).emit('stopTyping', { userId });
    });

    socket.on('message', async (messageData, callback) => {
      try {
        const { error } = messageSchema.validate(messageData);
        if (error) return callback({ error: error.details[0].message });
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
        if (senderId !== socket.user.id) return callback({ error: 'Unauthorized sender' });
        await retryOperation(async () => {
          const recipient = await User.findById(recipientId).select('status').lean();
          if (!recipient) return callback({ error: 'Recipient not found' });
          const existingMessage = await Message.findOne({ clientMessageId })
            .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
            .lean();
          if (existingMessage) return callback({ message: existingMessage });
          const sender = await User.findById(senderId)
            .select('virtualNumber username photo')
            .lean();
          const message = new Message({
            senderId,
            recipientId,
            content: content || '',
            contentType,
            plaintextContent: plaintextContent || '',
            status: recipient?.status === 'online' ? 'delivered' : 'sent',
            caption,
            replyTo: replyTo && mongoose.isValidObjectId(replyTo) ? replyTo : undefined,
            originalFilename: messageData.originalFilename,
            clientMessageId,
            senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
            senderUsername: senderUsername || sender.username,
            senderPhoto: senderPhoto || sender.photo,
          });
          await message.save();
          const populatedMessage = await Message.findById(message._id)
            .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
            .lean();
          io.to(recipientId).emit('message', {
            ...populatedMessage,
            senderId: populatedMessage.senderId.toString(),
            recipientId: populatedMessage.recipientId.toString(),
            replyTo: populatedMessage.replyTo
              ? {
                  ...populatedMessage.replyTo,
                  senderId: populatedMessage.replyTo.senderId.toString(),
                  recipientId: populatedMessage.replyTo.recipientId.toString(),
                }
              : null,
          });
          io.to(senderId).emit('message', {
            ...populatedMessage,
            senderId: populatedMessage.senderId.toString(),
            recipientId: populatedMessage.recipientId.toString(),
            replyTo: populatedMessage.replyTo
              ? {
                  ...populatedMessage.replyTo,
                  senderId: populatedMessage.replyTo.senderId.toString(),
                  recipientId: populatedMessage.replyTo.recipientId.toString(),
                }
              : null,
          });
          io.to(senderId).emit('messageStatus', { messageIds: [message._id], status: recipient?.status === 'online' ? 'delivered' : 'sent' });
          await Promise.all([emitUpdatedChatList(io, senderId), emitUpdatedChatList(io, recipientId)]);
          callback({ message: populatedMessage });
        });
      } catch (err) {
        logError('Message send failed', { error: err.message, senderId: messageData.senderId });
        callback({ error: 'Failed to send message' });
      }
    });

    socket.on('editMessage', async ({ messageId, newContent, plaintextContent }, callback) => {
      try {
        const { error } = editMessageSchema.validate({ messageId, newContent, plaintextContent });
        if (error) return callback({ error: error.details[0].message });
        const message = await Message.findById(messageId);
        if (!message || message.senderId.toString() !== socket.user.id || message.contentType !== 'text') {
          return callback({ error: 'Unauthorized or invalid edit' });
        }
        message.content = newContent;
        message.plaintextContent = plaintextContent || '';
        message.updatedAt = new Date();
        await message.save();
        const populatedMessage = await Message.findById(message._id)
          .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
          .lean();
        io.to(message.recipientId.toString()).emit('editMessage', {
          ...populatedMessage,
          senderId: populatedMessage.senderId.toString(),
          recipientId: populatedMessage.recipientId.toString(),
        });
        io.to(message.senderId.toString()).emit('editMessage', {
          ...populatedMessage,
          senderId: populatedMessage.senderId.toString(),
          recipientId: populatedMessage.recipientId.toString(),
        });
        callback({ message: populatedMessage });
      } catch (err) {
        logError('Edit message failed', { error: err.message, messageId });
        callback({ error: 'Failed to edit message' });
      }
    });

    socket.on('deleteMessage', async ({ messageId, recipientId }, callback) => {
      try {
        const { error } = deleteMessageSchema.validate({ messageId, recipientId });
        if (error) return callback({ error: error.details[0].message });
        const message = await Message.findById(messageId);
        if (!message || message.senderId.toString() !== socket.user.id) {
          return callback({ error: 'Unauthorized to delete message' });
        }
        await Message.findByIdAndDelete(messageId);
        io.to(recipientId).emit('deleteMessage', { messageId, recipientId });
        io.to(message.senderId.toString()).emit('deleteMessage', { messageId, recipientId: message.senderId.toString() });
        await Promise.all([emitUpdatedChatList(io, message.senderId.toString()), emitUpdatedChatList(io, recipientId)]);
        callback({ status: 'success' });
      } catch (err) {
        logError('Delete message failed', { error: err.message, messageId });
        callback({ error: 'Failed to delete message' });
      }
    });

    socket.on('messageStatus', async ({ messageId, status }) => {
      try {
        if (!mongoose.isValidObjectId(messageId) || !['sent', 'delivered', 'read'].includes(status)) {
          socket.emit('error', { message: 'Invalid messageId or status' });
          return;
        }
        const message = await Message.findById(messageId);
        if (!message || message.recipientId.toString() !== socket.user.id) {
          socket.emit('error', { message: 'Unauthorized status update' });
          return;
        }
        message.status = status;
        message.updatedAt = new Date();
        await message.save();
        io.to(message.senderId.toString()).emit('messageStatus', { messageIds: [messageId], status });
      } catch (err) {
        logError('Message status update failed', { error: err.message, messageId });
        socket.emit('error', { message: 'Failed to update status' });
      }
    });

    socket.on('batchMessageStatus', async ({ messageIds, status, recipientId }, callback) => {
      try {
        if (
          !Array.isArray(messageIds) ||
          messageIds.length === 0 ||
          messageIds.length > 100 ||
          !messageIds.every((id) => mongoose.isValidObjectId(id)) ||
          !mongoose.isValidObjectId(recipientId) ||
          recipientId !== socket.user.id ||
          !['sent', 'delivered', 'read'].includes(status)
        ) {
          socket.emit('error', { message: 'Invalid messageIds, recipientId, or status' });
          return callback?.({ error: 'Invalid messageIds, recipientId, or status' });
        }
        await retryOperation(async () => {
          const updateResult = await Message.updateMany(
            { _id: { $in: messageIds }, recipientId },
            { status, updatedAt: new Date() },
            { wtimeout: 10000 }
          );
          if (updateResult.matchedCount === 0) {
            socket.emit('error', { message: 'No matching messages found' });
            return callback?.({ error: 'No matching messages found' });
          }
          const messages = await Message.find({ _id: { $in: messageIds }, recipientId })
            .select('senderId')
            .lean()
            .hint({ _id: 1 });
          const senderIds = [...new Set(messages.map((msg) => msg.senderId.toString()))];
          senderIds.forEach((senderId) => {
            io.to(senderId).emit('messageStatus', { messageIds, status });
          });
          callback?.({ status: 'success', updatedCount: updateResult.modifiedCount });
        });
      } catch (err) {
        logError('Batch status update failed', { error: err.message, recipientId, messageIdsCount: messageIds.length });
        socket.emit('error', { message: 'Failed to update batch status' });
        callback?.({ error: 'Failed to update batch status' });
      }
    });

    socket.on('disconnect', async () => {
      if (socket.user?.id) {
        await User.findByIdAndUpdate(socket.user.id, { status: 'offline', lastSeen: new Date() });
        io.to(socket.user.id).emit('userStatus', { userId: socket.user.id, status: 'offline', lastSeen: new Date() });
      }
      logger.info('Socket.IO disconnected', { userId: socket.user?.id });
    });
  });

  // Routes
  router.get('/health', (req, res) => res.json({ status: 'healthy' }));

  router.get('/chat-list', authMiddleware, async (req, res) => {
    const { userId, page = 0, limit = 50 } = req.query;
    try {
      if (!mongoose.isValidObjectId(userId)) {
        return res.status(400).json({ error: 'Invalid userId' });
      }
      const cacheKey = `chatList:${userId}:${page}:${limit}`;
      const cached = chatListCache.get(cacheKey);
      if (cached) {
        logger.info('Served cached chat list (HTTP)', { userId, page, count: cached.length });
        return res.status(200).json(cached);
      }
      const user = await User.findById(userId)
        .select('contacts')
        .populate({
          path: 'contacts',
          select: 'username virtualNumber photo status lastSeen',
          options: { skip: parseInt(page) * parseInt(limit), limit: parseInt(limit), sort: { lastSeen: -1 } },
        })
        .lean();
      if (!user?.contacts?.length) {
        chatListCache.set(cacheKey, []);
        return res.status(200).json([]);
      }
      const contactIds = user.contacts.map((c) => c._id);
      const latestMessages = await Message.aggregate([
        {
          $match: {
            $or: [
              { senderId: new mongoose.Types.ObjectId(userId), recipientId: { $in: contactIds } },
              { recipientId: new mongoose.Types.ObjectId(userId), senderId: { $in: contactIds } },
            ],
          },
        },
        { $sort: { createdAt: -1 } },
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
            unreadCount: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$recipientId', new mongoose.Types.ObjectId(userId)] }, { $eq: ['$status', 'delivered'] }] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]);
      const chatList = user.contacts.map((contact) => {
        const messageData = latestMessages.find((m) => m._id.toString() === contact._id.toString());
        return {
          id: contact._id.toString(),
          username: contact.username || 'Unknown',
          virtualNumber: contact.virtualNumber || '',
          photo: contact.photo || 'https://placehold.co/40x40',
          status: contact.status || 'offline',
          lastSeen: contact.lastSeen || null,
          latestMessage: messageData?.latestMessage
            ? {
                ...messageData.latestMessage,
                senderId: messageData.latestMessage.senderId.toString(),
                recipientId: messageData.latestMessage.recipientId.toString(),
              }
            : null,
          unreadCount: messageData?.unreadCount || 0,
        };
      });
      chatListCache.set(cacheKey, chatList);
      res.status(200).json(chatList);
    } catch (error) {
      logError('Chat list fetch failed', { userId, error: error.message });
      res.status(500).json({ error: 'Failed to fetch chat list' });
    }
  });

  router.post('/messages', authMiddleware, messageLimiter, async (req, res) => {
    try {
      const { error } = messageSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });
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
      if (senderId !== req.user._id.toString()) return res.status(403).json({ error: 'Unauthorized sender' });
      await retryOperation(async () => {
        const recipient = await User.findById(recipientId).select('status').lean();
        if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
        const existingMessage = await Message.findOne({ clientMessageId })
          .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
          .lean();
        if (existingMessage) return res.status(200).json({ message: existingMessage });
        const sender = await User.findById(senderId)
          .select('virtualNumber username photo')
          .lean();
        const message = new Message({
          senderId,
          recipientId,
          content: content || '',
          contentType,
          plaintextContent: plaintextContent || '',
          status: recipient.status === 'online' ? 'delivered' : 'sent',
          caption,
          replyTo: replyTo && mongoose.isValidObjectId(replyTo) ? replyTo : undefined,
          originalFilename: req.body.originalFilename,
          clientMessageId,
          senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
          senderUsername: senderUsername || sender.username,
          senderPhoto: senderPhoto || sender.photo,
        });
        await message.save();
        const populatedMessage = await Message.findById(message._id)
          .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
          .lean();
        io.to(recipientId).emit('message', {
          ...populatedMessage,
          senderId: populatedMessage.senderId.toString(),
          recipientId: populatedMessage.recipientId.toString(),
          replyTo: populatedMessage.replyTo
            ? {
                ...populatedMessage.replyTo,
                senderId: populatedMessage.replyTo.senderId.toString(),
                recipientId: populatedMessage.replyTo.recipientId.toString(),
              }
            : null,
        });
        io.to(senderId).emit('message', {
          ...populatedMessage,
          senderId: populatedMessage.senderId.toString(),
          recipientId: populatedMessage.recipientId.toString(),
          replyTo: populatedMessage.replyTo
            ? {
                ...populatedMessage.replyTo,
                senderId: populatedMessage.replyTo.senderId.toString(),
                recipientId: populatedMessage.replyTo.recipientId.toString(),
              }
            : null,
        });
        io.to(senderId).emit('messageStatus', { messageIds: [message._id], status: recipient.status === 'online' ? 'delivered' : 'sent' });
        await Promise.all([emitUpdatedChatList(io, senderId), emitUpdatedChatList(io, recipientId)]);
        res.status(201).json({ message: populatedMessage });
      });
    } catch (error) {
      logError('Save message error', { error: error.message, senderId: req.body.senderId });
      res.status(500).json({ error: 'Failed to save message' });
    }
  });

  router.post('/edit_message', authMiddleware, async (req, res) => {
    try {
      const { error } = editMessageSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });
      const { messageId, newContent, plaintextContent } = req.body;
      const message = await Message.findById(messageId);
      if (!message || message.senderId.toString() !== req.user._id.toString() || message.contentType !== 'text') {
        return res.status(403).json({ error: 'Unauthorized or invalid edit' });
      }
      message.content = newContent;
      message.plaintextContent = plaintextContent || '';
      message.updatedAt = new Date();
      await message.save();
      const populatedMessage = await Message.findById(message._id)
        .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
        .lean();
      io.to(message.recipientId.toString()).emit('editMessage', {
        ...populatedMessage,
        senderId: populatedMessage.senderId.toString(),
        recipientId: populatedMessage.recipientId.toString(),
      });
      io.to(message.senderId.toString()).emit('editMessage', {
        ...populatedMessage,
        senderId: poppedMessage.senderId.toString(),
        recipientId: populatedMessage.recipientId.toString(),
      });
      res.status(200).json({ message: populatedMessage });
    } catch (err) {
      logError('Edit message failed', { error: err.message, messageId: req.body.messageId });
      res.status(500).json({ error: 'Failed to edit message' });
    }
  });

  router.post('/delete_message', authMiddleware, async (req, res) => {
    try {
      const { error } = deleteMessageSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });
      const { messageId, recipientId } = req.body;
      const message = await Message.findById(messageId);
      if (!message || message.senderId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Unauthorized to delete message' });
      }
      await Message.findByIdAndDelete(messageId);
      io.to(recipientId).emit('deleteMessage', { messageId, recipientId });
      io.to(message.senderId.toString()).emit('deleteMessage', { messageId, recipientId: message.senderId.toString() });
      await Promise.all([emitUpdatedChatList(io, message.senderId.toString()), emitUpdatedChatList(io, recipientId)]);
      res.status(200).json({ status: 'success' });
    } catch (err) {
      logError('Delete message failed', { error: err.message, messageId: req.body.messageId });
      res.status(500).json({ error: 'Failed to delete message' });
    }
  });

  router.get('/messages', authMiddleware, async (req, res) => {
    const { userId, recipientId, limit = 50, skip = 0, since } = req.query;
    try {
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId) || userId !== req.user._id.toString()) {
        return res.status(400).json({ error: 'Invalid or unauthorized request' });
      }
      let query = {
        $or: [
          { senderId: userId, recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      };
      if (since && !isNaN(Date.parse(since))) {
        query.createdAt = { $gt: new Date(since) };
      }
      const messages = await Message.find(query)
        .sort({ createdAt: 1 })
        .skip(parseInt(skip))
        .limit(parseInt(limit))
        .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
        .lean();
      const deliveredMessageIds = messages
        .filter((msg) => msg.recipientId.toString() === userId && msg.status === 'delivered')
        .map((msg) => msg._id);
      if (deliveredMessageIds.length) {
        await Message.updateMany(
          { _id: { $in: deliveredMessageIds }, recipientId: userId },
          { status: 'read', updatedAt: new Date() }
        );
        const senderIds = [...new Set(messages
          .filter((msg) => deliveredMessageIds.includes(msg._id))
          .map((msg) => msg.senderId.toString())
        )];
        senderIds.forEach((senderId) => {
          io.to(senderId).emit('messageStatus', { messageIds: deliveredMessageIds, status: 'read' });
        });
      }
      const total = await Message.countDocuments(query);
      res.status(200).json({ messages, total });
    } catch (error) {
      logError('Messages fetch failed', { userId, recipientId, error: error.message });
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  router.post('/add_contact', authMiddleware, addContactLimiter, async (req, res) => {
    try {
      const { error } = addContactSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });
      const { userId, virtualNumber } = req.body;
      if (userId !== req.user._id.toString()) return res.status(403).json({ error: 'Unauthorized' });
      await retryOperation(async () => {
        const contact = await User.findOne({ virtualNumber })
          .select('_id username virtualNumber photo status lastSeen contacts')
          .lean();
        if (!contact) return res.status(404).json({ error: 'Contact not registered' });
        if (contact._id.toString() === userId) return res.status(400).json({ error: 'Cannot add self as contact' });
        const user = await User.findById(userId).select('contacts username virtualNumber photo status lastSeen');
        const userHasContact = user.contacts.some((id) => id.toString() === contact._id.toString());
        const contactHasUser = contact.contacts.some((id) => id.toString() === userId);
        if (userHasContact && contactHasUser) {
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
        const updates = [];
        if (!userHasContact) updates.push(User.updateOne({ _id: userId }, { $addToSet: { contacts: contact._id } }));
        if (!contactHasUser) updates.push(User.updateOne({ _id: contact._id }, { $addToSet: { contacts: userId } }));
        await Promise.all(updates);
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
        const userData = {
          id: user._id.toString(),
          username: user.username || 'Unknown',
          virtualNumber: user.virtualNumber || '',
          photo: user.photo || 'https://placehold.co/40x40',
          status: user.status || 'offline',
          lastSeen: user.lastSeen || null,
          latestMessage: null,
          unreadCount: 0,
        };
        chatListCache.delete(`chatList:${userId}`);
        chatListCache.delete(`chatList:${contact._id.toString()}`);
        io.to(userId).emit('contactData', { userId, contactData });
        io.to(contact._id.toString()).emit('contactData', { userId: contact._id.toString(), contactData: userData });
        await Promise.all([emitUpdatedChatList(io, userId), emitUpdatedChatList(io, contact._id.toString())]);
        res.status(201).json(contactData);
      });
    } catch (error) {
      logError('Add contact failed', { userId: req.body.userId, virtualNumber: req.body.virtualNumber, error: error.message });
      res.status(500).json({ error: 'Failed to add contact' });
    }
  });

  router.post('/upload', authMiddleware, uploadLimiter, upload.single('file'), async (req, res) => {
    try {
      const { userId, recipientId, clientMessageId, senderVirtualNumber, senderUsername, senderPhoto, caption } = req.body;
      if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId) || !clientMessageId || !req.file || userId !== req.user._id.toString()) {
        return res.status(400).json({ error: 'Invalid or unauthorized parameters' });
      }
      await retryOperation(async () => {
        const recipient = await User.findById(recipientId).select('status').lean();
        const existingMessage = await Message.findOne({ clientMessageId })
          .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
          .lean();
        if (existingMessage) return res.json({ message: existingMessage });
        const contentType = req.file.mimetype.startsWith('image/') ? 'image' :
                            req.file.mimetype.startsWith('video/') ? 'video' :
                            req.file.mimetype.startsWith('audio/') ? 'audio' : 'document';
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { resource_type: contentType === 'document' ? 'raw' : contentType, timeout: 15000 },
            (error, result) => error ? reject(error) : resolve(result)
          );
          require('stream').Readable.from(req.file.buffer).pipe(uploadStream);
        });
        const sender = await User.findById(userId)
          .select('virtualNumber username photo')
          .lean();
        const message = new Message({
          senderId: userId,
          recipientId,
          content: uploadResult.secure_url,
          contentType,
          plaintextContent: '',
          status: recipient?.status === 'online' ? 'delivered' : 'sent',
          caption,
          originalFilename: req.file.originalname,
          clientMessageId,
          senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
          senderUsername: senderUsername || sender.username,
          senderPhoto: senderPhoto || sender.photo,
        });
        await message.save();
        const populatedMessage = await Message.findById(message._id)
          .select('senderId recipientId content contentType plaintextContent status caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto createdAt updatedAt')
          .lean();
        chatListCache.delete(`chatList:${userId}`);
        chatListCache.delete(`chatList:${recipientId}`);
        io.to(recipientId).emit('message', {
          ...populatedMessage,
          senderId: populatedMessage.senderId.toString(),
          recipientId: populatedMessage.recipientId.toString(),
        });
        io.to(userId).emit('message', {
          ...populatedMessage,
          senderId: populatedMessage.senderId.toString(),
          recipientId: populatedMessage.recipientId.toString(),
        });
        io.to(userId).emit('messageStatus', { messageIds: [message._id], status: recipient?.status === 'online' ? 'delivered' : 'sent' });
        await Promise.all([emitUpdatedChatList(io, userId), emitUpdatedChatList(io, recipientId)]);
        res.json({ message: populatedMessage });
      });
    } catch (err) {
      logError('Media upload failed', { error: err.message, userId: req.body.userId });
      res.status(500).json({ error: 'Failed to upload media' });
    }
  });

  router.post('/logout', authMiddleware, async (req, res) => {
    try {
      const token = req.token;
      if (!token) return res.status(400).json({ error: 'No token provided' });
      await retryOperation(async () => {
        await TokenBlacklist.create({ token });
        const sockets = await io.in(req.user.id).fetchSockets();
        sockets.forEach((socket) => socket.disconnect(true));
        await User.findByIdAndUpdate(req.user.id, { status: 'offline', lastSeen: new Date() });
        io.to(req.user.id).emit('userStatus', { userId: req.user.id, status: 'offline', lastSeen: new Date() });
      });
      res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
      logError('Logout error', { error: error.message, userId: req.user?.id });
      try {
        await TokenBlacklist.create({ token: req.token });
      } catch (blacklistErr) {
        logError('Failed to blacklist token during logout', { error: blacklistErr.message });
      }
      res.status(500).json({ error: 'Failed to logout, please try again' });
    }
  });

  router.post('/log-error', async (req, res) => {
    try {
      const { error, stack, userId, route, timestamp } = req.body;
      logError('Client-side error', { error, stack, userId, route, timestamp });
      res.status(200).json({ message: 'Error logged successfully' });
    } catch (err) {
      logError('Failed to log client error', { error: err.message });
      res.status(500).json({ error: 'Failed to log error' });
    }
  });

  return router;
};