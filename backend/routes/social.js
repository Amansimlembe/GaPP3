const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const Message = require('../models/Message');
const User = require('../models/User');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const authMiddleware = require('../middleware/auth');
const cache = require('memory-cache');

// Cloudinary configuration
if (!cloudinary.config().cloud_name) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// In-memory cache for online status
const onlineUsers = new Map(); // Map<userId, { lastSeen: Date, socketId: string }>

// Cache middleware
const cacheMiddleware = (duration) => (req, res, next) => {
  const key = '__express__' + req.originalUrl || req.url;
  const cachedBody = cache.get(key);
  if (cachedBody) return res.send(cachedBody);
  res.sendResponse = res.send;
  res.send = (body) => {
    cache.put(key, body, duration * 1000);
    res.sendResponse(body);
  };
  next();
};

// Factory function to create the router with io
module.exports = (io) => {
  // Track online status and Socket.IO events
  io.on('connection', (socket) => {
    socket.on('join', async (userId) => {
      try {
        onlineUsers.set(userId, { lastSeen: new Date(), socketId: socket.id });
        const user = await User.findById(userId);
        if (user) {
          user.status = 'online';
          user.lastSeen = new Date();
          await user.save();
          io.emit('onlineStatus', { userId, status: 'online', lastSeen: user.lastSeen });
        }
        console.log(`${userId} joined`);
      } catch (error) {
        console.error('Error handling join event:', error);
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
          onlineUsers.delete(userId);
        }
        console.log(`${userId} left`);
      } catch (error) {
        console.error('Error handling leave event:', error);
      }
    });

    socket.on('ping', async ({ userId }) => {
      try {
        if (onlineUsers.has(userId)) {
          onlineUsers.set(userId, { ...onlineUsers.get(userId), lastSeen: new Date() });
          const user = await User.findById(userId);
          if (user && user.status !== 'online') {
            user.status = 'online';
            user.lastSeen = new Date();
            await user.save();
            io.emit('onlineStatus', { userId, status: 'online', lastSeen: user.lastSeen });
          }
        }
      } catch (error) {
        console.error('Error handling ping event:', error);
      }
    });

    socket.on('message', (msg) => {
      io.emit('message', msg);
    });

    socket.on('messageStatus', async ({ messageId, status, recipientId }) => {
      try {
        const message = await Message.findById(messageId);
        if (message && message.recipientId.toString() === recipientId) {
          message.status = status;
          await message.save();
          io.emit('messageStatus', { messageId, status });
        }
      } catch (error) {
        console.error('Error updating message status:', error);
      }
    });

    socket.on('typing', ({ userId, recipientId }) => {
      io.emit('typing', { userId, recipientId });
    });

    socket.on('stopTyping', ({ userId, recipientId }) => {
      io.emit('stopTyping', { userId, recipientId });
    });

    socket.on('disconnect', async () => {
      try {
        const userId = [...onlineUsers.entries()].find(([_, value]) => value.socketId === socket.id)?.[0];
        if (userId) {
          const user = await User.findById(userId);
          if (user) {
            user.status = 'offline';
            user.lastSeen = new Date();
            await user.save();
            io.emit('onlineStatus', { userId, status: 'offline', lastSeen: user.lastSeen });
          }
          onlineUsers.delete(userId);
          console.log(`User disconnected: ${socket.id}`);
        }
      } catch (error) {
        console.error('Error handling disconnect event:', error);
      }
    });
  });

  // Get user status
  router.get('/user-status/:userId', authMiddleware, async (req, res) => {
    try {
      const userId = req.params.userId;
      const user = await User.findById(userId).select('status lastSeen');
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ status: user.status || 'offline', lastSeen: user.lastSeen });
    } catch (error) {
      console.error('User status error:', error);
      res.status(500).json({ error: 'Failed to fetch user status', details: error.message });
    }
  });

  // Get social feed
  router.get('/feed', cacheMiddleware(60), async (req, res) => {
    try {
      const posts = await Post.find()
        .sort({ createdAt: -1 })
        .populate('userId', 'username photo');
      res.json(posts);
    } catch (error) {
      console.error('Feed fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch feed', details: error.message });
    }
  });

  // Get user's posts
  router.get('/my-posts/:userId', authMiddleware, cacheMiddleware(60), async (req, res) => {
    try {
      const posts = await Post.find({ userId: req.params.userId })
        .sort({ createdAt: -1 })
        .populate('userId', 'username photo');
      res.json(posts);
    } catch (error) {
      console.error('My posts fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch posts', details: error.message });
    }
  });

  // Create a new post
  router.post('/post', authMiddleware, upload.single('content'), async (req, res) => {
    try {
      const { id: userId } = req.user;
      const { contentType, caption } = req.body;
      if (!contentType) return res.status(400).json({ error: 'Content type is required' });

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
      res.json(post);
    } catch (error) {
      console.error('Post error:', error);
      res.status(500).json({ error: 'Failed to post', details: error.message });
    }
  });

  // Delete a post
  router.delete('/post/:postId', authMiddleware, async (req, res) => {
    try {
      const post = await Post.findById(req.params.postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      if (post.userId.toString() !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
      await Post.deleteJUan({ _id: req.params.postId });
      io.emit('postDeleted', req.params.postId);
      res.json({ success: true });
    } catch (error) {
      console.error('Delete post error:', error);
      res.status(500).json({ error: 'Failed to delete post', details: error.message });
    }
  });

  // Send a message
  router.post('/message', authMiddleware, upload.single('content'), async (req, res) => {
    try {
      const { senderId, recipientId, contentType, caption, iv, replyTo } = req.body;
      if (!senderId || !recipientId || !contentType) {
        return res.status(400).json({ error: 'Sender ID, recipient ID, and content type are required' });
      }

      if (senderId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized to send as this user' });
      }

      const sender = await User.findById(senderId);
      const recipient = await User.findById(recipientId);
      if (!sender || !recipient) {
        return res.status(404).json({ error: 'Sender or recipient not found' });
      }

      let contentUrl = req.body.content || '';
      if (req.file) {
        let resourceType;
        switch (contentType) {
          case 'image':
            resourceType = 'image';
            break;
          case 'video':
            resourceType = 'video';
            break;
          case 'audio':
            resourceType = 'video'; // Cloudinary uses 'video' for audio
            break;
          case 'document':
            resourceType = 'raw';
            break;
          default:
            resourceType = 'raw';
        }

        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { resource_type: resourceType, public_id: `${contentType}_${senderId}_${Date.now()}`, folder: `gapp_chat_${contentType}s` },
            (error, result) => (error ? reject(error) : resolve(result))
          ).end(req.file.buffer);
        });
        contentUrl = result.secure_url;
      } else if (contentType === 'text' && !iv) {
        return res.status(400).json({ error: 'Initialization vector (iv) is required for text messages' });
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

      io.emit('message', {
        ...message.toObject(),
        senderVirtualNumber: sender.virtualNumber,
        senderUsername: sender.username,
        senderPhoto: sender.photo,
      });

      res.json(message);
    } catch (error) {
      console.error('Message error:', error);
      res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
  });

  // Fetch messages
  router.get('/messages', authMiddleware, async (req, res) => {
    try {
      const { userId, recipientId, limit = 50, skip = 0 } = req.query;
      if (!userId || !recipientId) {
        return res.status(400).json({ error: 'User ID and Recipient ID are required' });
      }

      if (req.user.id !== userId) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }

      const cacheKey = `messages_${userId}_${recipientId}_${skip}_${limit}`;
      const cachedMessages = cache.get(cacheKey);
      if (cachedMessages) {
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
        messages: messages.reverse(), // Reverse to chronological order
        totalMessages,
        hasMore: parseInt(skip) + messages.length < totalMessages,
      };

      // Handle case where no messages exist (new contact)
      if (messages.length === 0) {
        response.messages = [];
        response.hasMore = false;
      }

      cache.put(cacheKey, response, 5 * 60 * 1000); // Cache for 5 minutes
      res.json(response);
    } catch (error) {
      console.error('Fetch messages error:', error);
      res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
    }
  });

  // Delete a message
  router.delete('/message/:messageId', authMiddleware, async (req, res) => {
    try {
      const message = await Message.findById(req.params.messageId);
      if (!message) return res.status(404).json({ error: 'Message not found' });

      if (message.senderId.toString() !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized to delete this message' });
      }

      await Message.deleteOne({ _id: req.params.messageId });
      io.emit('messageDeleted', req.params.messageId);
      res.json({ success: true });
    } catch (error) {
      console.error('Delete message error:', error);
      res.status(500).json({ error: 'Failed to delete message', details: error.message });
    }
  });

  // Update message status
  router.post('/message/status', authMiddleware, async (req, res) => {
    try {
      const { messageId, status, recipientId } = req.body;
      const message = await Message.findById(messageId);
      if (!message) return res.status(404).json({ error: 'Message not found' });
      if (message.recipientId.toString() !== recipientId || req.user.id !== recipientId) {
        return res.status(403).json({ error: 'Not authorized to update this message status' });
      }
      message.status = status;
      await message.save();
      io.emit('messageStatus', { messageId, status });
      res.json({ success: true });
    } catch (error) {
      console.error('Message status error:', error);
      res.status(500).json({ error: 'Failed to update status', details: error.message });
    }
  });

  // Like a post
  router.post('/like', authMiddleware, async (req, res) => {
    const { postId } = req.body;
    const userId = req.user.id;
    try {
      const post = await Post.findById(postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      if (!post.likedBy.includes(userId)) {
        post.likedBy.push(userId);
        post.likes = (post.likes || 0) + 1;
        await post.save();
      }
      res.json(post);
    } catch (error) {
      console.error('Like error:', error);
      res.status(500).json({ error: 'Server error', details: error.message });
    }
  });

  // Unlike a post
  router.post('/unlike', authMiddleware, async (req, res) => {
    try {
      const { postId } = req.body;
      const userId = req.user.id;
      const post = await Post.findById(postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      if (!post.likedBy?.includes(userId)) return res.status(400).json({ error: 'Not liked yet' });
      post.likes = (post.likes || 0) - 1;
      post.likedBy = post.likedBy.filter((id) => id.toString() !== userId);
      await post.save();
      res.json(post);
    } catch (error) {
      console.error('Unlike error:', error);
      res.status(500).json({ error: 'Failed to unlike post', details: error.message });
    }
  });

  // Comment on a post
  router.post('/comment', authMiddleware, async (req, res) => {
    try {
      const { postId, comment } = req.body;
      const userId = req.user.id;
      const user = await User.findById(userId);
      const post = await Post.findById(postId);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      const commentData = { userId, username: user.username, photo: user.photo, comment, createdAt: new Date() };
      post.comments = [...(post.comments || []), commentData];
      await post.save();
      res.json(commentData);
    } catch (error) {
      console.error('Comment error:', error);
      res.status(500).json({ error: 'Failed to comment', details: error.message });
    }
  });

  return router;
};