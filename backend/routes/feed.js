const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Post = require('../models/Post');
const User = require('../models/User');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { authMiddleware } = require('./auth');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/feed-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/feed-combined.log' }),
  ],
});

// Configure Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = {
      image: ['image/jpeg', 'image/png'],
      video: ['video/mp4', 'video/webm'],
      audio: ['audio/mpeg', 'audio/wav'],
      raw: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    };
    const contentType = req.body.contentType;
    if (!file || (contentType && allowedTypes[contentType]?.includes(file.mimetype))) {
      cb(null, true);
    } else {
      logger.warn('Invalid file type', { contentType, mimetype: file?.mimetype });
      cb(new Error(`Invalid file type for ${contentType}`));
    }
  },
});

// Get feed with pagination
router.get('/', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const posts = await Post.find({ isStory: false })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const totalPosts = await Post.countDocuments({ isStory: false });
    const hasMore = skip + posts.length < totalPosts;

    res.json({ posts, hasMore });
  } catch (err) {
    logger.error('Failed to fetch feed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

// Create a new post
router.post('/', authMiddleware, upload.single('content'), async (req, res) => {
  try {
    const { userId, contentType, caption } = req.body;
    let contentUrl = '';

    if (contentType !== 'text' && req.file) {
      const uploadOptions = {
        resource_type: contentType,
        folder: 'feed',
        transformation: contentType === 'video' ? [
          { width: 720, height: 1280, crop: 'fill', quality: 'auto' },
          { format: 'mp4', video_codec: 'h264' }
        ] : contentType === 'image' ? [
          { width: 1080, height: 1080, crop: 'fit', quality: 'auto' }
        ] : null,
      };

      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          uploadOptions,
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        req.file.pipe(uploadStream);
      });

      contentUrl = result.secure_url;

      const user = await User.findById(userId).select('username photo');
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const post = new Post({
        userId,
        contentType,
        content: contentUrl,
        caption: contentType !== 'text' ? caption : '',
        username: user.username,
        photo: user.photo,
        createdAt: new Date().toISOString()
      });

      await post.save();
      req.app.get('io').emit('newPost', post);
      res.json(post);
    } else if (contentType === 'text' && caption) {
      const user = await User.findById(userId).select('username photo');
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const post = new Post({
        userId,
        contentType,
        content: caption,
        caption: '',
        username: user.username,
        photo: user.photo,
        createdAt: new Date().toISOString()
      });

      await post.save();
      req.app.get('io').emit('newPost', post);
      res.json(post);
    } else {
      res.status(400).json({ error: 'Missing required content' });
    }
  } catch (err) {
    logger.error('Failed to create post', { error: err.message });
    res.status(400).json({ error: err.message || 'Failed to create post' });
  }
});

// Like a post
router.post('/like', authMiddleware, async (req, res) => {
  try {
    const { postId, userId } = req.body;
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    post.likes = post.likedBy.includes(userId) ? post.likes - 1 : post.likes + 1;
    post.likedBy = post.likedBy.includes(userId)
      ? post.likedBy.filter((id) => id !== userId)
      : [...post.likedBy, userId];

    await post.save();
    req.app.get('io').emit('postUpdate', post);
    res.json(post);
  } catch (err) {
    logger.error('Failed to like post', { error: err.message });
    res.status(500).json({ error: 'Failed to like post' });
  }
});

// Unlike a post
router.post('/unlike', authMiddleware, async (req, res) => {
  try {
    const { postId, userId } = req.body;
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    post.likes = post.likedBy.includes(userId) ? post.likes - 1 : post.likes;
    post.likedBy = post.likedBy.filter((id) => id !== userId);

    await post.save();
    req.app.get('io').emit('postUpdate', post);
    res.json(post);
  } catch (err) {
    logger.error('Failed to unlike post', { error: err.message });
    res.status(500).json({ error: 'Failed to unlike post' });
  }
});

// Comment on a post
router.post('/comment', authMiddleware, async (req, res) => {
  try {
    const { postId, userId, comment } = req.body;
    const user = await User.findById(userId).select('username photo');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const newComment = { userId, comment, username: user.username, photo: user.photo, createdAt: new Date() };
    post.comments.push(newComment);
    await post.save();

    req.app.get('io').emit('postUpdate', post);
    res.json(newComment);
  } catch (err) {
    logger.error('Failed to comment', { error: err.message });
    res.status(400).json({ error: 'Failed to comment' });
  }
});

module.exports = router;