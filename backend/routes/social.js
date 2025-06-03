const express = require('express');
const { authMiddleware } = require('./auth');
const Message = require('../models/Message');
const User = require('../models/User');
const redis = require('../redis');
const winston = require('winston');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const Joi = require('joi');
const mongoose = require('mongoose'); // Added for ObjectId validation

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
  userId: Joi.string()
    .custom((value, helpers) => {
      if (!mongoose.isValidObjectId(value)) {
        return helpers.error('any.invalid');
      }
      return value;
    }, 'ObjectId validation')
    .required(),
  virtualNumber: Joi.string().required(),
});

const deleteUserSchema = Joi.object({
  userId: Joi.string()
    .custom((value, helpers) => {
      if (!mongoose.isValidObjectId(value)) {
        return helpers.error('any.invalid');
      }
      return value;
    }, 'ObjectId validation')
    .required(),
});

module.exports = (io) => {
  const router = express.Router();

  // Helper function to fetch and emit updated chat list
  const emitUpdatedChatList = async (userId) => {
    try {
      const contacts = await User.find({ contacts: userId }).select(
        'username virtualNumber photo status lastSeen'
      );
      const chatList = await Promise.all(
        contacts.map(async (contact) => {
          const latestMessage = await Message.findOne({
            $or: [
              { senderId: userId, recipientId: contact._id },
              { senderId: contact._id, recipientId: userId },
            ],
          })
            .sort({ createdAt: -1 })
            .select('content contentType senderId recipientId createdAt plaintextContent');

          const unreadCount = await Message.countDocuments({
            senderId: contact._id,
            recipientId: userId,
            status: { $ne: 'read' },
          });

          return {
            id: contact._id.toString(),
            username: contact.username,
            virtualNumber: contact.virtualNumber,
            photo: contact.photo,
            status: contact.status,
            lastSeen: contact.lastSeen,
            latestMessage: latestMessage ? latestMessage.toObject() : null,
            unreadCount,
          };
        })
      );

      io.to(userId).emit('chatListUpdated', { userId, users: chatList });
      await redis.setex(`:chat-list:${userId}`, 300, JSON.stringify(chatList));
      logger.info('Emitted updated chat list', { userId });
    } catch (error) {
      logger.error('Failed to emit updated chat list', { error: error.message, userId });
    }
  };

  io.on('connection', (socket) => {
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
            emitUpdatedChatList(userId); // Emit updated chat list on join
            logger.info('User joined', { userId });
          }
        })
        .catch((err) => {
          logger.error('User join failed', { error: err.message, userId });
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
          logger.error('User leave failed', { error: err.message, userId });
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
            // Emit updated chat list for both users
            emitUpdatedChatList(userId);
            emitUpdatedChatList(contactData.id);
            logger.info('New contact emitted', { userId, contactId: contactData.id });
          }
        })
        .catch((err) => {
          logger.error('New contact emission failed', { error: err.message, userId, contactId: contactData.id });
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

    if (
      !mongoose.isValidObjectId(senderId) ||
      !mongoose.isValidObjectId(recipientId) ||
      !content ||
      !contentType ||
      !clientMessageId
    ) {
      logger.warn('Missing or invalid message fields', { messageData });
      return callback({ error: 'Missing required fields: senderId, recipientId, content, contentType, clientMessageId' });
    }

    if (!validContentTypes.includes(contentType)) {
      logger.warn('Invalid contentType', { contentType });
      return callback({ error: `Invalid contentType. Must be one of: ${validContentTypes.join(', ')}` });
    }

    const sender = await User.findById(senderId);
    const recipient = await User.findById(recipientId);
    if (!sender || !recipient) {
      logger.warn('Sender or recipient not found', { senderId, recipientId });
      return callback({ error: 'Sender or recipient not found' });
    }

    const existingMessage = await Message.findOne({ clientMessageId });
    if (existingMessage) {
      logger.info('Duplicate message found', { clientMessageId });
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
      originalFilename: originalFilename || undefined,
      clientMessageId,
      senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
      senderUsername: senderUsername || sender.username,
      senderPhoto: senderPhoto || sender.photo,
    });

    await message.save();
    io.to(recipientId).emit('message', message.toObject());
    io.to(senderId).emit('message', message.toObject());
    emitUpdatedChatList(senderId);
    emitUpdatedChatList(recipientId);
    logger.info('Message sent', { messageId: message._id, senderId, recipientId });
    callback({ message: message.toObject() });

    await redis.del(`:chat-list:${senderId}`);
    await redis.del(`:chat-list:${recipientId}`);
  } catch (error) {
    logger.error('Socket message failed', { error: error.message, stack: error.stack });
    callback({ error: 'Failed to send message', details: error.message });
  }
});

    socket.on('editMessage', async ({ messageId, newContent, plaintextContent }, callback) => {
      try {
        if (!mongoose.isValidObjectId(messageId)) {
          logger.warn('Invalid messageId in editMessage', { messageId });
          return callback({ error: 'Invalid messageId' });
        }
        const message = await Message.findById(messageId);
        if (!message) {
          logger.warn('Message not found for edit', { messageId });
          return callback({ error: 'Message not found' });
        }

        message.content = newContent;
        message.plaintextContent = plaintextContent;
        message.updatedAt = new Date();
        await message.save();

        io.to(message.recipientId).emit('editMessage', message.toObject());
        io.to(message.senderId).emit('editMessage', message.toObject());
        logger.info('Message edited', { messageId });
        callback({ message: message.toObject() });
      } catch (error) {
        logger.error('Edit message failed', { error: error.message, stack: error.stack });
        callback({ error: 'Failed to edit message', details: error.message });
      }
    });

    socket.on('deleteMessage', async ({ messageId, recipientId }, callback) => {
      try {
        if (!mongoose.isValidObjectId(messageId) || !mongoose.isValidObjectId(recipientId)) {
          logger.warn('Invalid IDs in deleteMessage', { messageId, recipientId });
          return callback({ error: 'Invalid messageId or recipientId' });
        }

        const message = await Message.findById(messageId);
        if (!message) {
          logger.warn('Message not found for deletion', { messageId });
          return callback({ error: 'Message not found' });
        }

        await Message.deleteOne({ _id: messageId });
        io.to(recipientId).emit('deleteMessage', { messageId, recipientId });
        io.to(message.senderId).emit('deleteMessage', { messageId, recipientId: message.senderId });
        logger.info('Message deleted', { messageId });
        callback({});
      } catch (error) {
        logger.error('Delete message failed', { error: error.message, stack: error.stack });
        callback({ error: 'Failed to delete message', details: error.message });
      }
    });

    socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
      try {
        if (!mongoose.isValidObjectId(messageId) || !mongoose.isValidObjectId(recipientId)) {
          logger.warn('Invalid IDs in messageStatus', { messageId, recipientId });
          return;
        }
        const message = await Message.findById(messageId);
        if (!message) {
          logger.warn('Message not found for status update', { messageId });
          return;
        }

        if (['sent', 'delivered', 'read'].includes(status)) {
          message.status = status;
          await message.save();
          io.to(message.senderId).emit('messageStatus', { messageId, status });
          io.to(recipientId).emit('messageStatus', { messageId, status });
          logger.info('Message status updated', { messageId, status });
        }
      } catch (error) {
        logger.error('Message status update failed', { error: error.message, stack: error.stack });
      }
    });

    socket.on('batchMessageStatus', async ({ messageIds, status, recipientId }) => {
      try {
        if (
          !messageIds.every((id) => mongoose.isValidObjectId(id)) ||
          !mongoose.isValidObjectId(recipientId)
        ) {
          logger.warn('Invalid IDs in batchMessageStatus', { messageIds, recipientId });
          return;
        }
        const messages = await Message.find({ _id: { $in: messageIds } });
        if (!messages.length) {
          logger.warn('No messages found for batch status update', { messageIds });
          return;
        }

        await Message.updateMany(
          { _id: { $in: messageIds } },
          { $set: { status, updatedAt: new Date() } }
        );

        messages.forEach((message) => {
          io.to(message.senderId).emit('messageStatus', { messageId: message._id, status });
          io.to(recipientId).emit('messageStatus', { messageId: message._id, status });
        });
        logger.info('Batch message status updated', { messageIds, status });
      } catch (error) {
        logger.error('Batch message status update failed', { error: error.message, stack: error.stack });
      }
    });
  });

  // GET /social/chat-list
  router.get('/chat-list', authMiddleware, async (req, res) => {
    const { userId } = req.query;
    if (!mongoose.isValidObjectId(userId)) {
      logger.warn('Invalid userId in chat-list request', { userId });
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const cacheKey = `:chat-list:${userId}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info('Chat list served from cache', { userId });
        return res.json(JSON.parse(cached));
      }

      const contacts = await User.find({ contacts: userId }).select(
        'username virtualNumber photo status lastSeen'
      );
      const chatList = await Promise.all(
        contacts.map(async (contact) => {
          const latestMessage = await Message.findOne({
            $or: [
              { senderId: userId, recipientId: contact._id },
              { senderId: contact._id, recipientId: userId },
            ],
          })
            .sort({ createdAt: -1 })
            .select('content contentType senderId recipientId createdAt plaintextContent');

          const unreadCount = await Message.countDocuments({
            senderId: contact._id,
            recipientId: userId,
            status: { $ne: 'read' },
          });

          return {
            id: contact._id.toString(),
            username: contact.username,
            virtualNumber: contact.virtualNumber,
            photo: contact.photo,
            status: contact.status,
            lastSeen: contact.lastSeen,
            latestMessage: latestMessage ? latestMessage.toObject() : null,
            unreadCount,
          };
        })
      );

      await redis.setex(cacheKey, 300, JSON.stringify(chatList));
      logger.info('Chat list fetched and cached', { userId });
      res.json(chatList);
    } catch (error) {
      logger.error('Chat list fetch failed', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to fetch chat list', details: error.message });
    }
  });

  // GET /social/messages
  router.get('/messages', authMiddleware, async (req, res) => {
    const { userId, recipientId, limit = 50, skip = 0 } = req.query;
    if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(recipientId)) {
      logger.warn('Invalid userId or recipientId in messages request', { userId, recipientId });
      return res.status(400).json({ error: 'Invalid userId or recipientId' });
    }

    const cacheKey = `:messages:${userId}:${recipientId}:${limit}:${skip}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info('Messages served from cache', { userId, recipientId });
        return res.json(JSON.parse(cached));
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
        .select('senderId recipientId content contentType status createdAt updatedAt caption replyTo originalFilename clientMessageId senderVirtualNumber senderUsername senderPhoto plaintextContent');

      const total = await Message.countDocuments({
        $or: [
          { senderId: userId, recipientId },
          { senderId: recipientId, recipientId: userId },
        ],
      });

      const response = { messages: messages.reverse(), total };
      await redis.setex(cacheKey, 300, JSON.stringify(response));
      logger.info('Messages fetched and cached', { userId, recipientId });
      res.json(response);
    } catch (error) {
      logger.error('Messages fetch failed', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
    }
  });

  // POST /social/add_contact
  router.post('/add_contact', authMiddleware, async (req, res) => {
    try {
      const { error } = addContactSchema.validate(req.body);
      if (error) {
        logger.warn('Invalid add contact request', { error: error.details });
        return res.status(400).json({ error: error.details[0].message });
      }

      const { userId, virtualNumber } = req.body;
      const user = await User.findById(userId);
      if (!user) {
        logger.warn('User not found for add contact', { userId });
        return res.status(404).json({ error: 'User not found' });
      }

      const contact = await User.findOne({ virtualNumber });
      if (!contact) {
        logger.warn('Contact not found', { virtualNumber });
        return res.status(400).json({ error: 'Contact not found' }); // Changed from 404 to 400
      }

      if (contact._id.toString() === userId) {
        logger.warn('Cannot add self as contact', { userId });
        return res.status(400).json({ error: 'Cannot add yourself as a contact' });
      }

      if (user.contacts.includes(contact._id)) {
        logger.info('Contact already exists', { userId, contactId: contact._id });
        return res.status(400).json({ error: 'Contact already exists' });
      }

      user.contacts.push(contact._id);
      await user.save();

      // Add the user to the contact's contacts list (mutual contact addition)
      if (!contact.contacts.includes(user._id)) {
        contact.contacts.push(user._id);
        await contact.save();
      }

      const contactData = {
        id: contact._id.toString(),
        username: contact.username,
        virtualNumber: contact.virtualNumber,
        photo: contact.photo,
        status: contact.status,
        lastSeen: contact.lastSeen,
      };

      // Emit newContact and chatListUpdated events to both users
      io.to(userId).emit('newContact', { userId, contactData });
      io.to(contact._id.toString()).emit('newContact', { userId: contact._id.toString(), contactData });
      emitUpdatedChatList(userId);
      emitUpdatedChatList(contact._id.toString());

      // Invalidate caches for both users
      await redis.del(`:chat-list:${userId}`);
      await redis.del(`:chat-list:${contact._id}`);
      await redis.del(`:contacts:${userId}`);
      await redis.del(`:contacts:${contact._id}`);

      logger.info('Contact added successfully', { userId, contactId: contact._id });
      res.json(contactData);
    } catch (error) {
      logger.error('Add contact failed', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to add contact', details: error.message });
    }
  });

  // POST /social/upload
  router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
    try {
      const { userId, recipientId, clientMessageId, senderVirtualNumber, senderUsername, senderPhoto, caption } = req.body;
      if (
        !mongoose.isValidObjectId(userId) ||
        !mongoose.isValidObjectId(recipientId) ||
        !clientMessageId ||
        !req.file
      ) {
        logger.warn('Missing or invalid fields in upload request', { userId, recipientId });
        return res.status(400).json({ error: 'userId, recipientId, clientMessageId, and file are required' });
      }

      const sender = await User.findById(userId);
      const recipient = await User.findById(recipientId);
      if (!sender || !recipient) {
        logger.warn('Sender or recipient not found', { userId, recipientId });
        return res.status(404).json({ error: 'Sender or recipient not found' });
      }

      const contentType = req.file.mimetype.startsWith('image/')
        ? 'image'
        : req.file.mimetype.startsWith('video/')
        ? 'video'
        : req.file.mimetype.startsWith('audio/')
        ? 'audio'
        : 'document';

      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: contentType === 'document' ? 'raw' : contentType },
        async (error, result) => {
          if (error) {
            logger.error('Cloudinary upload failed', { error: error.message });
            return res.status(500).json({ error: 'Failed to upload file', details: error.message });
          }

          const message = new Message({
            senderId: userId,
            recipientId,
            content: result.secure_url,
            contentType,
            status: 'sent',
            caption: caption || undefined,
            originalFilename: req.file.originalname,
            clientMessageId,
            senderVirtualNumber: senderVirtualNumber || sender.virtualNumber,
            senderUsername: senderUsername || sender.username,
            senderPhoto: senderPhoto || sender.photo,
          });

          await message.save();
          io.to(recipientId).emit('message', message.toObject());
          io.to(userId).emit('message', message.toObject());
          emitUpdatedChatList(userId); // Update chat list for sender
          emitUpdatedChatList(recipientId); // Update chat list for recipient
          logger.info('Media message uploaded and sent', { messageId: message._id, userId, recipientId });

          // Invalidate chat-list cache for both users
          await redis.del(`:chat-list:${userId}`);
          await redis.del(`:chat-list:${recipientId}`);

          res.json({ message: message.toObject() });
        }
      );

      require('stream').Readable.from(req.file.buffer).pipe(uploadStream);
    } catch (error) {
      logger.error('Upload failed', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to upload file', details: error.message });
    }
  });

  // POST /social/delete_user
  router.post('/delete_user', authMiddleware, async (req, res) => {
    try {
      const { error } = deleteUserSchema.validate(req.body);
      if (error) {
        logger.warn('Invalid delete user request', { error: error.details });
        return res.status(400).json({ error: error.details[0].message });
      }

      const { userId } = req.body;
      const user = await User.findById(userId);
      if (!user) {
        logger.warn('User not found for deletion', { userId });
        return res.status(404).json({ error: 'User not found' });
      }

      // Get user's contacts to notify them
      const contacts = await User.find({ contacts: userId }).select('_id');
      const contactIds = contacts.map((contact) => contact._id.toString());

      // Delete the user (triggers pre middleware for messages and contacts)
      await User.deleteOne({ _id: userId });

      // Invalidate caches
      await redis.del(`:chat-list:${userId}`);
      await redis.del(`:contacts:${userId}`);
      for (const contactId of contactIds) {
        await redis.del(`:chat-list:${contactId}`);
        await redis.del(`:contacts:${contactId}`);
        emitUpdatedChatList(contactId); // Update chat list for contacts
      }

      // Emit userDeleted event to contacts
      io.to(contactIds).emit('userDeleted', { userId });
      logger.info('User deleted successfully', { userId, notifiedContacts: contactIds.length });

      res.json({ message: 'User deleted successfully' });
    } catch (error) {
      logger.error('Delete user failed', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to delete user', details: error.message });
    }
  });

  return router;
};