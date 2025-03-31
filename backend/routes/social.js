const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const Message = require('../models/Message');
const User = require('../models/User');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { authMiddleware } = require('../routes/auth');
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: { error: 'Too many requests, please try again later.' },
});

const messageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many messages sent, please try again later.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'audio/mpeg', 'application/pdf'];
    if (!allowedTypes.includes(file.mimetype)) return cb(new Error('Invalid file type. Only JPEG, PNG, GIF, MP4, MP3, and PDF allowed.'));
    cb(null, true);
  },
});

const postSchema = Joi.object({
  contentType: Joi.string().valid('image', 'video', 'audio', 'raw', 'text').required(),
  caption: Joi.string().max(500).allow('').optional(),
});

const messageSchema = Joi.object({
  senderId: Joi.string().required(),
  recipientId: Joi.string().required(),
  contentType: Joi.string().valid('text', 'image', 'video', 'audio', 'document').required(),
  content: Joi.string().when('contentType', { is: 'text', then: Joi.required(), otherwise: Joi.optional() }),
  caption: Joi.string().max(500).allow('').optional(),
  replyTo: Joi.string().optional(),
});

const messageStatusSchema = Joi.object({
  messageId: Joi.string().required(),
  status: Joi.string().valid('sent', 'delivered', 'read').required(),
  recipientId: Joi.string().required(),
});

const likeSchema = Joi.object({
  postId: Joi.string().required(),
  userId: Joi.string().required(),
});

const commentSchema = Joi.object({
  postId: Joi.string().required(),
  comment: Joi.string().max(500).required(),
  userId: Joi.string().required(),
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = (io) => {
  io.on('connection', (socket) => {
    logger.info('User connected', { socketId: socket.id });

    socket.on('join', async (userId) => {
      try {
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
      } catch (error) {
        logger.error('Join event error', { error: error.message, userId });
      }
    });

    socket.on('leave', async (userId) => {
      try {
        const user = await User.findById(userId);
        if (!user) return logger.warn('User not found on leave', { userId });

        user.status = 'offline';
        user.lastSeen = new Date();
        await user.save();
        io.emit('onlineStatus', { userId, status: 'offline', lastSeen: user.lastSeen });
        logger.info('User left', { userId });
      } catch (error) {
        logger.error('Leave event error', { error: error.message, userId });
      }
    });

    let lastPing = {};
    socket.on('ping', async ({ userId }) => {
      try {
        const now = Date.now();
        if (lastPing[userId] && now - lastPing[userId] < 5000) return;
        lastPing[userId] = now;

        const user = await User.findById(userId);
        if (!user) return;
        if (user.status !== 'online') {
          user.status = 'online';
          user.lastSeen = new Date();
          await user.save();
          io.emit('onlineStatus', { userId, status: 'online', lastSeen: user.lastSeen });
        }
      } catch (error) {
        logger.error('Ping event error', { error: error.message, userId });
      }
    });

    socket.on('message', async (msg) => {
      try {
        const recipientOnline = io.sockets.adapter.rooms.has(msg.recipientId);
        if (recipientOnline) io.to(msg.recipientId).emit('message', msg);
        else await redis.lpush(`undelivered:${msg.recipientId}`, JSON.stringify(msg));
        io.to(msg.senderId).emit('message', msg);
        logger.info('Message broadcast', { messageId: msg._id });
      } catch (error) {
        logger.error('Message broadcast error', { error: error.message, messageId: msg._id });
      }
    });

    socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message || message.recipientId.toString() !== recipientId) return;
        message.status = status;
        await message.save();
        io.to(message.senderId).emit('messageStatus', { messageId, status });
        io.to(recipientId).emit('messageStatus', { messageId, status });
        logger.info('Message status updated', { messageId, status });
      } catch (error) {
        logger.error('Message status update error', { error: error.message, messageId });
      }
    });

    socket.on('typing', ({ userId, recipientId }) => io.to(recipientId).emit('typing', { userId, recipientId }));
    socket.on('stopTyping', ({ userId, recipientId }) => io.to(recipientId).emit('stopTyping', { userId, recipientId }));

    socket.on('disconnect', async () => {
      try {
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
      } catch (error) {
        logger.error('Disconnect event error', { error: error.message });
      }
    });
  });

  router.get('/user-status/:userId', authMiddleware, async (req, res) => {
    try {
      const user = await User.findById(req.params.userId).select('status lastSeen');
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ status: user.status || 'offline', lastSeen: user.lastSeen });
    } catch (error) {
      logger.error('User status fetch error', { error: error.message, userId: req.params.userId });
      res.status(500).json({ error: 'Failed to fetch user status' });
    }
  });

  router.get('/feed', socialLimiter, async (req, res) => {
    try {
      const cacheKey = 'feed';
      const cachedFeed = await redis.get(cacheKey);
      if (cachedFeed) {
        logger.info('Feed cache hit', { cacheKey });
        return res.json(JSON.parse(cachedFeed));
      }
      const posts = await Post.find().sort({ createdAt: -1 }).lean();
      await redis.setex(cacheKey, 60, JSON.stringify(posts));
      res.json(posts);
    } catch (error) {
      logger.error('Feed fetch error', { error: error.message });
      res.status(500).json({ error: 'Failed to fetch feed' });
    }
  });

  router.get('/my-posts/:userId', authMiddleware, socialLimiter, async (req, res) => {
    try {
      if (req.user.id !== req.params.userId) return res.status(403).json({ error: 'Unauthorized' });
      const cacheKey = `my-posts:${req.params.userId}`;
      const cachedPosts = await redis.get(cacheKey);
      if (cachedPosts) {
        logger.info('Posts cache hit', { cacheKey });
        return res.json(JSON.parse(cachedPosts));
      }
      const posts = await Post.find({ userId: req.params.userId }).sort({ createdAt: -1 }).lean();
      if (!posts.length) logger.info('No posts found', { userId: req.params.userId });
      await redis.setex(cacheKey, 300, JSON.stringify(posts));
      res.json(posts);
    } catch (error) {
      logger.error('My posts fetch error', { error: error.message, userId: req.params.userId });
      res.status(500).json({ error: 'Failed to fetch posts' });
    }
  });

  router.post('/post', authMiddleware, socialLimiter, upload.single('content'), async (req, res) => {
    try {
      const { error } = postSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { id: userId } = req.user;
      const { contentType, caption } = req.body;
      let contentUrl = contentType === 'text' ? req.body.content || caption : '';
      if (req.file) {
        const resourceType = { image: 'image', video: 'video', audio: 'video', raw: 'raw' }[contentType] || 'raw';
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { resource_type: resourceType, folder: `gapp_${contentType}s`, public_id: `${contentType}_${userId}_${Date.now()}` },
            (error, result) => error ? reject(error) : resolve(result)
          ).end(req.file.buffer);
        });
        contentUrl = result.secure_url;
      }
      if (!contentUrl) return res.status(400).json({ error: 'Content is required' });

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const post = new Post({ userId, contentType, content: contentUrl, caption, username: user.username, photo: user.photo, likedBy: [] });
      await post.save();
      await redis.del('feed');
      res.json(post.toObject());
    } catch (error) {
      logger.error('Post creation error', { error: error.message, userId: req.user.id });
      res.status(500).json({ error: 'Failed to create post' });
    }
  });

  router.delete('/post/:postId', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const post = await Post.findById(req.params.postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      if (post.userId.toString() !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

      await Post.deleteOne({ _id: req.params.postId });
      await redis.del('feed');
      res.json({ success: true });
    } catch (error) {
      logger.error('Post deletion error', { error: error.message, postId: req.params.postId });
      res.status(500).json({ error: 'Failed to delete post' });
    }
  });

  router.post('/like', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { error } = likeSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { postId, userId } = req.body;
      if (userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

      const post = await Post.findById(postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });

      if (!post.likedBy.includes(userId)) {
        post.likedBy.push(userId);
        post.likes = (post.likes || 0) + 1;
        await post.save();
        await redis.del('feed');
      }
      res.json(post.toObject());
    } catch (error) {
      logger.error('Like error', { error: error.message, postId: req.body.postId });
      res.status(500).json({ error: 'Failed to like post' });
    }
  });

  router.post('/unlike', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { error } = likeSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { postId, userId } = req.body;
      if (userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

      const post = await Post.findById(postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      if (!post.likedBy.includes(userId)) return res.status(400).json({ error: 'Not liked yet' });

      post.likes = (post.likes || 0) - 1;
      post.likedBy = post.likedBy.filter((id) => id.toString() !== userId);
      await post.save();
      await redis.del('feed');
      res.json(post.toObject());
    } catch (error) {
      logger.error('Unlike error', { error: error.message, postId: req.body.postId });
      res.status(500).json({ error: 'Failed to unlike post' });
    }
  });

  router.post('/comment', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { error } = commentSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { postId, comment, userId } = req.body;
      if (userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const post = await Post.findById(postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });

      const commentData = { userId, username: user.username, photo: user.photo, comment, createdAt: new Date() };
      post.comments = [...(post.comments || []), commentData];
      await post.save();
      await redis.del('feed');
      res.json(commentData);
    } catch (error) {
      logger.error('Comment error', { error: error.message, postId: req.body.postId });
      res.status(500).json({ error: 'Failed to comment' });
    }
  });

  router.post('/message', authMiddleware, messageLimiter, upload.single('content'), async (req, res) => {
    try {
      const { error } = messageSchema.validate(req.body);
      if (error) {
        logger.warn('Message validation failed', { error: error.details[0].message, body: req.body });
        return res.status(400).json({ error: error.details[0].message });
      }

      const { senderId, recipientId, contentType, caption, replyTo } = req.body;
      if (senderId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

      const sender = await User.findById(senderId);
      const recipient = await User.findById(recipientId);
      if (!sender || !recipient) return res.status(404).json({ error: 'Sender or recipient not found' });

      let contentUrl = req.body.content;
      if (['image', 'video', 'audio', 'document'].includes(contentType)) {
        if (!req.file) {
          logger.warn('No file provided for media message', { senderId, contentType });
          return res.status(400).json({ error: 'File required for media message' });
        }
        const resourceType = { image: 'image', video: 'video', audio: 'video', document: 'raw' }[contentType];
        try {
          const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
              { resource_type: resourceType, folder: `gapp_chat_${contentType}s`, public_id: `${contentType}_${senderId}_${Date.now()}` },
              (error, result) => error ? reject(error) : resolve(result)
            ).end(req.file.buffer);
          });
          contentUrl = result.secure_url;
          logger.info('Media uploaded to Cloudinary', { senderId, contentUrl });
        } catch (uploadErr) {
          logger.error('Cloudinary upload failed', { error: uploadErr.message, senderId });
          return res.status(500).json({ error: 'Failed to upload media' });
        }
      } else if (contentType === 'text' && !contentUrl) {
        logger.warn('No content provided for text message', { senderId });
        return res.status(400).json({ error: 'Text content is required' });
      }

      const message = new Message({
        senderId,
        recipientId,
        contentType,
        content: contentUrl,
        caption,
        status: 'sent',
        replyTo: replyTo || undefined,
      });
      await message.save();

      const messageData = {
        ...message.toObject(),
        senderVirtualNumber: sender.virtualNumber,
        senderUsername: sender.username,
        senderPhoto: sender.photo,
      };

      const recipientOnline = io.sockets.adapter.rooms.has(recipientId);
      if (recipientOnline) io.to(recipientId).emit('message', messageData);
      else await redis.lpush(`undelivered:${recipientId}`, JSON.stringify(messageData));
      io.to(senderId).emit('message', messageData);

      logger.info('Message sent', { messageId: message._id, senderId, recipientId });
      res.json(message.toObject());
    } catch (error) {
      logger.error('Message send error', { error: error.message, senderId: req.user.id, stack: error.stack });
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  router.get('/messages', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { userId, recipientId, limit = 50, skip = 0 } = req.query;
      if (!userId || !recipientId) return res.status(400).json({ error: 'User ID and Recipient ID required' });
      if (req.user.id !== userId) return res.status(403).json({ error: 'Unauthorized' });

      const cacheKey = `messages:${userId}:${recipientId}:${skip}:${limit}`;
      const cachedMessages = await redis.get(cacheKey);
      if (cachedMessages) {
        logger.info('Messages cache hit', { cacheKey });
        return res.json(JSON.parse(cachedMessages));
      }

      const total = await Message.countDocuments({
        $or: [{ senderId: userId, recipientId }, { senderId: recipientId, recipientId: userId }],
      });
      const messages = await Message.find({
        $or: [{ senderId: userId, recipientId }, { senderId: recipientId, recipientId: userId }],
      })
        .sort({ createdAt: -1 })
        .skip(parseInt(skip))
        .limit(parseInt(limit))
        .lean();

      const response = { messages: messages.reverse(), hasMore: parseInt(skip) + messages.length < total };
      await redis.setex(cacheKey, 300, JSON.stringify(response));
      res.json(response);
    } catch (error) {
      logger.error('Messages fetch error', { error: error.message, userId: req.query.userId });
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  router.delete('/message/:messageId', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const message = await Message.findById(req.params.messageId);
      if (!message) return res.status(404).json({ error: 'Message not found' });
      if (message.senderId.toString() !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

      await Message.deleteOne({ _id: req.params.messageId });
      const undeliveredKey = `undelivered:${message.recipientId}`;
      const undelivered = await redis.lrange(undeliveredKey, 0, -1);
      if (undelivered.length) {
        const updated = undelivered.filter((msg) => JSON.parse(msg)._id !== req.params.messageId);
        await redis.del(undeliveredKey);
        if (updated.length) await redis.lpush(undeliveredKey, updated);
      }
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

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing Redis connection');
  await redis.quit();
  process.exit(0);
});