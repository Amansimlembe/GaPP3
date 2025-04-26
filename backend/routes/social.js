const express = require('express');
const { authMiddleware } = require('./auth');
const Message = require('../models/Message');
const User = require('../models/User');
const redis = require('../redis');
const winston = require('winston');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
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

// Initialize Cloudinary once
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
    api_key: cloudinaryConfig.api_key,
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

const addContactSchema = Joi.object({
  userId: Joi.string().required(),
  virtualNumber: Joi.string().required(),
});

module.exports = (io) => {
  const router = express.Router();

  io.on('connection', (socket) => {
    socket.on('join', (userId) => {
      socket.join(userId);
      User.findByIdAndUpdate(userId, { status: 'online', lastSeen: new Date() }, { new: true }).then((user) => {
        if (user) {
          io.to(userId).emit('userStatus', { userId, status: 'online', lastSeen: user.lastSeen });
        }
      }).catch((err) => {
        logger.error('User join failed:', { error: err.message });
      });
    });

    socket.on('leave', (userId) => {
      User.findByIdAndUpdate(userId, { status: 'offline', lastSeen: new Date() }, { new: true }).then((user) => {
        if (user) {
          io.to(userId).emit('userStatus', { userId, status: 'offline', lastSeen: user.lastSeen });
        }
      }).catch((err) => {
        logger.error('User leave failed:', { error: err.message });
      });
      socket.leave(userId);
    });

    socket.on('typing', ({ userId, recipientId }) => {
      io.to(recipientId).emit('typing', { userId });
    });

    socket.on('stopTyping', ({ userId, recipientId }) => {
      io.to(recipientId).emit('stopTyping', { userId });
    });

    socket.on('newContact', ({ userId, contactData }) => {
      User.findById(contactData.id).then((contact) => {
        if (contact) {
          io.to(userId).emit('newContact', contact.toObject());
          io.to(contactData.id).emit('newContact', contact.toObject());
        }
      }).catch((err) => {
        logger.error('New contact failed:', { error: err.message });
      });
    });

    socket.on('message', async (messageData, callback) => {
      try {
        const {
          senderId,
          recipientId,
          content,
          contentType,
          plaintextContent,
          caption,
          replyTo,
          originalFilename,
          clientMessageId,
          senderVirtualNumber,
          senderUsername,
          senderPhoto,
        } = messageData;

        if (!senderId || !recipientId || !content || !contentType) {
          return callback({ error: 'Missing required fields: senderId, recipientId, content, contentType' });
        }

        if (!validContentTypes.includes(contentType)) {
          return callback({ error: `Invalid contentType. Must be one of: ${validContentTypes.join(', ')}` });
        }

        const sender = await User.findById(senderId);
        const recipient = await User.findById(recipientId);
        if (!sender || !recipient) {
          return callback({ error: 'Sender or recipient not found' });
        }

        const existingMessage = await Message.findOne({ clientMessageId });
        if (existingMessage) {
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
          replyTo: replyTo || undefined,
          originalFilename: originalFilename || undefined,
          clientMessageId: clientMessageId || `${senderId}-${Date.now()}`,
          senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
          senderUsername: senderUsername || sender.username,
          senderPhoto: senderPhoto || sender.photo,
        });

        await message.save();
        io.to(recipientId).emit('message', message.toObject());
        io.to(senderId).emit('message', message.toObject());
        callback({ message });
      } catch (error) {
        logger.error('Socket message failed:', { error: error.message, stack: error.stack });
        callback({ error: 'Failed to send message', details: error.message });
      }
    });

    socket.on('editMessage', async ({ messageId, newContent, plaintextContent }, callback) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return callback({ error: 'Message not found' });

        message.content = newContent;
        message.plaintextContent = plaintextContent;
        message.updatedAt = new Date();
        await message.save();

        io.to(message.recipientId).emit('editMessage', message.toObject());
        io.to(message.senderId).emit('editMessage', message.toObject());
        callback({ message });
      } catch (error) {
        logger.error('Edit message failed:', { error: error.message, stack: error.stack });
        callback({ error: 'Failed to edit message', details: error.message });
      }
    });

    socket.on('deleteMessage', async ({ messageId, recipientId }, callback) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return callback({ error: 'Message not found' });

        await Message.deleteOne({ _id: messageId });
        io.to(recipientId).emit('deleteMessage', { messageId, recipientId });
        io.to(message.senderId).emit('deleteMessage', { messageId, recipientId: message.senderId });
        callback({});
      } catch (error) {
        logger.error('Delete message failed:', { error: error.message, stack: error.stack });
        callback({ error: 'Failed to delete message', details: error.message });
      }
    });

    socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return;

        message.status = status;
        await message.save();
        io.to(recipientId).emit('messageStatus', { messageId, status });
      } catch (error) {
        logger.error('Message status update failed:', { error: error.message, stack: error.stack });
      }
    });

    socket.on('batchMessageStatus', async ({ messageIds, status, recipientId }) => {
      try {
        const messages = await Message.find({ _id: { $in: messageIds } });
        for (const message of messages) {
          message.status = status;
          await message.save();
          io.to(recipientId).emit('messageStatus', { messageId: message._id, status });
        }
      } catch (error) {
        logger.error('Batch message status update failed:', { error: error.message, stack: error.stack });
      }
    });
  });

  router.get('/chat-list', authMiddleware, async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });

      const cacheKey = `chat-list:${userId}`;
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));

      const user = await User.findById(userId).populate(
        'contacts',
        'username virtualNumber photo status lastSeen'
      );
      if (!user) return res.status(404).json({ error: 'User not found' });

      const chatList = await Promise.all(
        user.contacts.map(async (contact) => {
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
            latestMessage: latestMessage
              ? {
                  ...latestMessage.toObject(),
                  senderId: latestMessage.senderId.toString(),
                  recipientId: latestMessage.recipientId.toString(),
                }
              : null,
            unreadCount: await Message.countDocuments({
              senderId: contact._id,
              recipientId: userId,
              status: { $ne: 'read' },
            }),
          };
        })
      );

      const sortedChatList = chatList.sort(
        (a, b) => new Date(b.latestMessage?.createdAt || 0) - new Date(a.latestMessage?.createdAt || 0)
      );
      await redis.setex(cacheKey, 60 * 60, JSON.stringify(sortedChatList));
      res.json(sortedChatList);
    } catch (error) {
      logger.error('Chat list fetch failed:', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to fetch chat list', details: error.message });
    }
  });

  router.get('/messages', authMiddleware, async (req, res) => {
    try {
      const { userId, recipientId, limit = 50, skip = 0, since } = req.query;
      if (!userId || !recipientId) return res.status(400).json({ error: 'userId and recipientId are required' });

      const cacheKey = `messages:${userId}:${recipientId}:${skip}:${limit}`;
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));

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
        .select(
          'senderId recipientId content contentType plaintextContent status createdAt replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto caption'
        );

      const hasMore = messages.length > Number(limit);
      if (hasMore) messages.pop();

      const response = { messages, hasMore };
      await redis.setex(cacheKey, 60 * 60, JSON.stringify(response));
      res.json(response);
    } catch (error) {
      logger.error('Messages fetch failed:', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
    }
  });

  router.post('/message', authMiddleware, async (req, res) => {
    try {
      const {
        senderId,
        recipientId,
        content,
        contentType,
        plaintextContent,
        caption,
        replyTo,
        originalFilename,
        clientMessageId,
        senderVirtualNumber,
        senderUsername,
        senderPhoto,
      } = req.body;

      if (!senderId || !recipientId || !content || !contentType) {
        return res.status(400).json({ error: 'Missing required fields: senderId, recipientId, content, contentType' });
      }

      if (!validContentTypes.includes(contentType)) {
        return res.status(400).json({ error: `Invalid contentType. Must be one of: ${validContentTypes.join(', ')}` });
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
        originalFilename: originalFilename || undefined,
        clientMessageId: clientMessageId || `${senderId}-${Date.now()}`,
        senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
        senderUsername: senderUsername || sender.username,
        senderPhoto: senderPhoto || sender.photo,
      });

      await message.save();
      io.to(recipientId).emit('message', message.toObject());
      io.to(senderId).emit('message', message.toObject());

      res.status(201).json({ message });
    } catch (error) {
      logger.error('Message send failed:', { error: error.message, stack: error.stack, body: req.body });
      res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
  });

  router.post('/upload', upload.single('file'), authMiddleware, async (req, res) => {
    try {
      const { userId, recipientId, clientMessageId, caption, senderVirtualNumber, senderUsername, senderPhoto } = req.body;
      const file = req.file;

      if (!userId || !recipientId || !file) {
        return res.status(400).json({ error: 'Missing required fields: userId, recipientId, or file' });
      }

      const sender = await User.findById(userId);
      if (!sender) return res.status(404).json({ error: 'Sender not found' });

      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: file.mimetype.startsWith('video')
              ? 'video'
              : file.mimetype.startsWith('audio')
              ? 'auto'
              : 'image',
            folder: 'gapp_media',
          },
          (error, result) => (error ? reject(error) : resolve(result))
        );
        stream.end(file.buffer);
      });

      const contentType = file.mimetype.startsWith('image')
        ? 'image'
        : file.mimetype.startsWith('video')
        ? 'video'
        : file.mimetype.startsWith('audio')
        ? 'audio'
        : 'document';
      const message = new Message({
        senderId: userId,
        recipientId,
        content: result.secure_url,
        contentType,
        status: 'sent',
        caption: caption || undefined,
        originalFilename: file.originalname,
        clientMessageId: clientMessageId || `${userId}-${Date.now()}`,
        senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
        senderUsername: senderUsername || sender.username,
        senderPhoto: senderPhoto || sender.photo,
      });

      await message.save();
      io.to(recipientId).emit('message', message.toObject());
      io.to(senderId).emit('message', message.toObject());

      res.status(201).json({ message });
    } catch (error) {
      logger.error('File upload failed:', { error: error.message, stack: error.stack, body: req.body });
      if (error.message.includes('Invalid file type')) {
        return res.status(400).json({ error: 'Invalid file type', details: 'Supported types: image, video, audio, document' });
      }
      if (error.message.includes('File too large')) {
        return res.status(400).json({ error: 'File too large', details: 'Maximum file size is 50MB' });
      }
      res.status(500).json({ error: 'Failed to upload file', details: error.message });
    }
  });

  router.post('/add_contact', authMiddleware, async (req, res) => {
    try {
      const { error } = addContactSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { userId, virtualNumber } = req.body;
      if (userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const contact = await User.findOne({ virtualNumber });
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
      if (user.contacts.includes(contact._id)) return res.status(400).json({ error: 'Contact already added' });

      // Add contact to user's contact list
      user.contacts.push(contact._id);
      await user.save();

      // Mutual contact addition: add user to contact's contact list
      if (!contact.contacts.includes(user._id)) {
        contact.contacts.push(user._id);
        await contact.save();
      }

      // Prepare contact data for user
      const contactData = {
        id: contact._id,
        username: contact.username,
        virtualNumber: contact.virtualNumber,
        photo: contact.photo || 'https://placehold.co/40x40',
        status: contact.status,
        lastSeen: contact.lastSeen,
      };

      // Prepare user data for contact
      const userData = {
        id: user._id,
        username: user.username,
        virtualNumber: user.virtualNumber,
        photo: user.photo || 'https://placehold.co/40x40',
        status: user.status,
        lastSeen: user.lastSeen,
      };

      // Invalidate caches for both users
      await redis.del(`contacts:${userId}`);
      await redis.del(`chat-list:${userId}`);
      await redis.del(`contacts:${contact._id}`);
      await redis.del(`chat-list:${contact._id}`);

      // Emit newContact events to both users
      io.to(userId).emit('newContact', { userId, contactData });
      io.to(contact._id).emit('newContact', { userId: contact._id, contactData: userData });

      logger.info('Contact added mutually', { userId, contactId: contact._id });
      res.json(contactData);
    } catch (error) {
      logger.error('Add contact error:', { error: error.message, stack: error.stack, userId: req.body.userId });
      res.status(500).json({ error: 'Failed to add contact', details: error.message });
    }
  });

  return router;
};