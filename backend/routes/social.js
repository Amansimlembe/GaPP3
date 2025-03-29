const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const Message = require('../models/Message');
const User = require('../models/User');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { authMiddleware } = require('../routes/auth');
const cache = require('memory-cache');
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
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'audio/mpeg', 'application/pdf'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Only JPEG, PNG, GIF, MP4, MP3, and PDF are allowed.'));
    }
    cb(null, true);
  },
});

const cacheMiddleware = (duration) => (req, res, next) => {
  const key = '__express__' + req.originalUrl || req.url;
  const cachedBody = cache.get(key);
  if (cachedBody) {
    logger.info('Cache hit', { key });
    return res.send(cachedBody);
  }
  res.sendResponse = res.send;
  res.send = (body) => {
    cache.put(key, body, duration * 1000);
    res.sendResponse(body);
  };
  next();
};

const postSchema = Joi.object({
  contentType: Joi.string().valid('image', 'video', 'audio', 'raw', 'text').required(),
  caption: Joi.string().allow('').optional(),
});

const messageSchema = Joi.object({
  senderId: Joi.string().required(),
  recipientId: Joi.string().required(),
  contentType: Joi.string().valid('text', 'image', 'video', 'audio', 'document').required(),
  caption: Joi.string().allow('').optional(),
  iv: Joi.string().when('contentType', { is: 'text', then: Joi.required(), otherwise: Joi.optional() }),
  replyTo: Joi.string().optional(),
});

const messageStatusSchema = Joi.object({
  messageId: Joi.string().required(),
  status: Joi.string().valid('sent', 'delivered', 'read').required(),
  recipientId: Joi.string().required(),
});

const likeSchema = Joi.object({
  postId: Joi.string().required(),
  userId: Joi.string().required(), // Added for consistency with frontend
});

const commentSchema = Joi.object({
  postId: Joi.string().required(),
  comment: Joi.string().max(500).required(),
  userId: Joi.string().required(), // Added for consistency with frontend
});

module.exports = (io) => {
  io.on('connection', (socket) => {
    logger.info('User connected', { socketId: socket.id });

    socket.on('join', async (userId) => {
      try {
        socket.join(userId);
        const user = await User.findById(userId);
        if (user) {
          user.status = 'online';
          user.lastSeen = new Date();
          await user.save();
          io.emit('onlineStatus', { userId, status: 'online', lastSeen: user.lastSeen });
        }
        logger.info('User joined', { userId });
      } catch (error) {
        logger.error('Error handling join event', { error: error.message });
      }
    });

    socket.on('leave', async (userId) => {
      try {
        const user = await User.findById(userId);
        if (user) {
          user.status = 'offline';
          user.lastSeen = new Date();
          await user.save();
          io.emit('onlineStatus', { userId, status: 'offline', lastSeen: user.lastSeen });
        }
        logger.info('User left', { userId });
      } catch (error) {
        logger.error('Error handling leave event', { error: error.message });
      }
    });

    socket.on('ping', async ({ userId }) => {
      try {
        const user = await User.findById(userId);
        if (user && user.status !== 'online') {
          user.status = 'online';
          user.lastSeen = new Date();
          await user.save();
          io.emit('onlineStatus', { userId, status: 'online', lastSeen: user.lastSeen });
        }
        logger.info('Ping received', { userId });
      } catch (error) {
        logger.error('Error handling ping event', { error: error.message });
      }
    });

    socket.on('message', (msg) => {
      io.emit('message', msg);
      logger.info('Message broadcast', { messageId: msg._id });
    });

    socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
      try {
        const message = await Message.findById(messageId);
        if (message && message.recipientId.toString() === recipientId) {
          message.status = status;
          await message.save();
          io.emit('messageStatus', { messageId, status });
          logger.info('Message status updated', { messageId, status });
        }
      } catch (error) {
        logger.error('Error updating message status', { error: error.message });
      }
    });

    socket.on('typing', ({ userId, recipientId }) => {
      io.to(recipientId).emit('typing', { userId, recipientId });
      logger.info('Typing event', { userId, recipientId });
    });

    socket.on('stopTyping', ({ userId, recipientId }) => {
      io.to(recipientId).emit('stopTyping', { userId, recipientId });
      logger.info('Stop typing event', { userId, recipientId });
    });

    socket.on('newPost', (post) => {
      io.emit('newPost', post);
      logger.info('New post event', { postId: post._id });
    });

    socket.on('postUpdate', (post) => {
      io.emit('postUpdate', post);
      logger.info('Post update event', { postId: post._id });
    });

    socket.on('postDeleted', (postId) => {
      io.emit('postDeleted', postId);
      logger.info('Post deleted event', { postId });
    });

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
        logger.error('Error handling disconnect event', { error: error.message });
      }
    });
  });

  // Get user status
  router.get('/user-status/:userId', authMiddleware, async (req, res) => {
    try {
      const userId = req.params.userId;
      const user = await User.findById(userId).select('status lastSeen');
      if (!user) return res.status(404).json({ error: 'User not found' });
      logger.info('User status fetched', { userId });
      res.json({ status: user.status || 'offline', lastSeen: user.lastSeen });
    } catch (error) {
      logger.error('User status error', { error: error.message });
      res.status(500).json({ error: 'Failed to fetch user status', details: error.message });
    }
  });

  // Get social feed
  router.get('/feed', socialLimiter, cacheMiddleware(60), async (req, res) => {
    try {
      const posts = await Post.find()
        .sort({ createdAt: -1 })
        .lean(); // Use lean for performance, no need to populate since username/photo are in Post
      logger.info('Social feed fetched');
      res.json(posts);
    } catch (error) {
      logger.error('Feed fetch error', { error: error.message });
      res.status(500).json({ error: 'Failed to fetch feed', details: error.message });
    }
  });

  // Get user's posts
  router.get('/my-posts/:userId', authMiddleware, socialLimiter, cacheMiddleware(60), async (req, res) => {
    try {
      const posts = await Post.find({ userId: req.params.userId })
        .sort({ createdAt: -1 })
        .lean();
      logger.info('User posts fetched', { userId: req.params.userId });
      res.json(posts);
    } catch (error) {
      logger.error('My posts fetch error', { error: error.message });
      res.status(500).json({ error: 'Failed to fetch posts', details: error.message });
    }
  });

  // Create a new post
  router.post('/post', authMiddleware, socialLimiter, upload.single('content'), async (req, res) => {
    try {
      const { error } = postSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { id: userId } = req.user;
      const { contentType, caption } = req.body;

      let contentUrl = caption || '';
      if (req.file) {
        const resourceType = ['image', 'video', 'audio', 'raw'].includes(contentType) ? contentType : 'raw';
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { resource_type: resourceType, public_id: `${contentType}_${userId}_${Date.now()}`, folder: `gapp_${contentType}s` },
            (error, result) => (error ? reject(error) : resolve(result))
          ).end(req.file.buffer);
        });
        contentUrl = result.secure_url;
      }

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const post = new Post({
        userId,
        contentType,
        content: contentUrl,
        caption,
        username: user.username,
        photo: user.photo,
        likedBy: [],
      });
      await post.save();

      io.emit('newPost', post.toObject());
      logger.info('Post created', { postId: post._id, userId });
      res.json(post.toObject());
    } catch (error) {
      logger.error('Post error', { error: error.message });
      res.status(500).json({ error: 'Failed to post', details: error.message });
    }
  });

  // Delete a post
  router.delete('/post/:postId', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const post = await Post.findById(req.params.postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      if (post.userId.toString() !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

      await Post.deleteOne({ _id: req.params.postId });
      io.emit('postDeleted', req.params.postId);
      logger.info('Post deleted', { postId: req.params.postId, userId: req.user.id });
      res.json({ success: true });
    } catch (error) {
      logger.error('Delete post error', { error: error.message });
      res.status(500).json({ error: 'Failed to delete post', details: error.message });
    }
  });

  // Like a post
  router.post('/like', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { error } = likeSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { postId, userId } = req.body;
      if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

      const post = await Post.findById(postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });

      if (!post.likedBy.includes(userId)) {
        post.likedBy.push(userId);
        post.likes = (post.likes || 0) + 1;
        await post.save();
        io.emit('postUpdate', post.toObject());
        logger.info('Post liked', { postId, userId });
      }
      res.json(post.toObject());
    } catch (error) {
      logger.error('Like error', { error: error.message });
      res.status(500).json({ error: 'Failed to like post', details: error.message });
    }
  });

  // Unlike a post
  router.post('/unlike', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { error } = likeSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { postId, userId } = req.body;
      if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

      const post = await Post.findById(postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      if (!post.likedBy?.includes(userId)) return res.status(400).json({ error: 'Not liked yet' });

      post.likes = (post.likes || 0) - 1;
      post.likedBy = post.likedBy.filter((id) => id.toString() !== userId);
      await post.save();
      io.emit('postUpdate', post.toObject());
      logger.info('Post unliked', { postId, userId });
      res.json(post.toObject());
    } catch (error) {
      logger.error('Unlike error', { error: error.message });
      res.status(500).json({ error: 'Failed to unlike post', details: error.message });
    }
  });

  // Comment on a post
  router.post('/comment', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { error } = commentSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { postId, comment, userId } = req.body;
      if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const post = await Post.findById(postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });

      const commentData = { userId, username: user.username, photo: user.photo, comment, createdAt: new Date() };
      post.comments = [...(post.comments || []), commentData];
      await post.save();
      io.emit('postUpdate', post.toObject());
      logger.info('Comment added', { postId, userId });
      res.json(commentData);
    } catch (error) {
      logger.error('Comment error', { error: error.message });
      res.status(500).json({ error: 'Failed to comment', details: error.message });
    }
  });

  // Send a message
  router.post('/message', authMiddleware, socialLimiter, upload.single('content'), async (req, res) => {
    try {
      const { error } = messageSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { senderId, recipientId, contentType, caption, iv, replyTo } = req.body;
      if (senderId !== req.user.id) return res.status(403).json({ error: 'Not authorized to send as this user' });

      const sender = await User.findById(senderId);
      const recipient = await User.findById(recipientId);
      if (!sender || !recipient) return res.status(404).json({ error: 'Sender or recipient not found' });

      let contentUrl = req.body.content || '';
      if (req.file) {
        let resourceType;
        switch (contentType) {
          case 'image': resourceType = 'image'; break;
          case 'video': resourceType = 'video'; break;
          case 'audio': resourceType = 'video'; break; // Cloudinary uses 'video' for audio
          case 'document': resourceType = 'raw'; break;
          default: resourceType = 'raw';
        }
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { resource_type: resourceType, public_id: `${contentType}_${senderId}_${Date.now()}`, folder: `gapp_chat_${contentType}s` },
            (error, result) => (error ? reject(error) : resolve(result))
          ).end(req.file.buffer);
        });
        contentUrl = result.secure_url;
      }

      const message = new Message({
        senderId,
        recipientId,
        contentType,
        content: contentUrl,
        iv: contentType === 'text' ? iv : undefined,
        caption,
        status: 'sent',
        replyTo: replyTo || undefined,
        createdAt: new Date(),
      });
      await message.save();

      const messageData = {
        ...message.toObject(),
        senderVirtualNumber: sender.virtualNumber,
        senderUsername: sender.username,
        senderPhoto: sender.photo,
      };
      io.to(recipientId).emit('message', messageData);
      io.to(senderId).emit('message', messageData);

      logger.info('Message sent', { messageId: message._id, senderId, recipientId });
      res.json(message.toObject());
    } catch (error) {
      logger.error('Message error', { error: error.message });
      res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
  });

  // Fetch messages
  router.get('/messages', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { userId, recipientId, limit = 50, skip = 0 } = req.query;
      if (!userId || !recipientId) return res.status(400).json({ error: 'User ID and Recipient ID are required' });
      if (req.user.id !== userId) return res.status(403).json({ error: 'Unauthorized access' });

      const cacheKey = `messages_${userId}_${recipientId}_${skip}_${limit}`;
      const cachedMessages = cache.get(cacheKey);
      if (cachedMessages) {
        logger.info('Messages cache hit', { cacheKey });
        return res.json(cachedMessages);
      }

      const totalMessages = await Message.countDocuments({
        $or: [
          { senderId: userId, recipientId: recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      });

      const messages = await Message.find({
        $or: [
          { senderId: userId, recipientId: recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      })
        .select('senderId recipientId contentType content iv caption status replyTo createdAt')
        .sort({ createdAt: -1 })
        .skip(parseInt(skip))
        .limit(parseInt(limit))
        .lean();

      const response = {
        messages: messages.reverse(),
        totalMessages,
        hasMore: parseInt(skip) + messages.length < totalMessages,
      };

      if (messages.length === 0) {
        response.messages = [];
        response.hasMore = false;
      }

      cache.put(cacheKey, response, 5 * 60 * 1000);
      logger.info('Messages fetched', { userId, recipientId });
      res.json(response);
    } catch (error) {
      logger.error('Fetch messages error', { error: error.message });
      res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
    }
  });

  // Delete a message
  router.delete('/message/:messageId', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const message = await Message.findById(req.params.messageId);
      if (!message) return res.status(404).json({ error: 'Message not found' });
      if (message.senderId.toString() !== req.user.id) return res.status(403).json({ error: 'Not authorized to delete this message' });

      await Message.deleteOne({ _id: req.params.messageId });
      io.emit('messageDeleted', req.params.messageId);
      logger.info('Message deleted', { messageId: req.params.messageId, userId: req.user.id });
      res.json({ success: true });
    } catch (error) {
      logger.error('Delete message error', { error: error.message });
      res.status(500).json({ error: 'Failed to delete message', details: error.message });
    }
  });

  // Update message status
  router.post('/message/status', authMiddleware, socialLimiter, async (req, res) => {
    try {
      const { error } = messageStatusSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { messageId, status, recipientId } = req.body;
      const message = await Message.findById(messageId);
      if (!message) return res.status(404).json({ error: 'Message not found' });
      if (message.recipientId.toString() !== recipientId || req.user.id !== recipientId) {
        return res.status(403).json({ error: 'Not authorized to update this message status' });
      }

      message.status = status;
      await message.save();
      io.to(message.senderId).emit('messageStatus', { messageId, status });
      io.to(recipientId).emit('messageStatus', { messageId, status });
      logger.info('Message status updated', { messageId, status, recipientId });
      res.json({ success: true });
    } catch (error) {
      logger.error('Message status error', { error: error.message });
      res.status(500).json({ error: 'Failed to update status', details: error.message });
    }
  });

  return router;
};