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
      logger.warn('Invalid file type', { contentType, mimetype: file?.mimetype, userId: req.body.userId });
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

    const [posts, totalPosts] = await Promise.all([
      Post.find({ isStory: false })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
        
      Post.countDocuments({ isStory: false }),
    ]);

    const hasMore = skip + posts.length < totalPosts;
    logger.info('Fetched feed', { userId: req.user.userId, page, limit, postCount: posts.length });

    res.json({ posts, hasMore });
  } catch (err) {
    logger.error('Failed to fetch feed', { error: err.message, userId: req.user.userId });
    res.status(500).json({ error: 'Failed to fetch feed', details: err.message });
  }
});

// Create a new post
router.post('/', authMiddleware, upload.single('content'), async (req, res) => {
  try {
    const { userId, contentType, caption } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const user = await User.findById(userId).select('username photo');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let contentUrl = '';
    if (contentType !== 'text' && req.file) {
      const uploadOptions = {
        resource_type: contentType,
        folder: 'feed',
        timeout: 60000, // 60s timeout
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
        req.file.stream.pipe(uploadStream);
      });

      contentUrl = result.secure_url;
    } else if (contentType === 'text' && caption) {
      contentUrl = caption;
    } else {
      return res.status(400).json({ error: 'Missing required content' });
    }

    const post = new Post({
      userId: mongoose.Types.ObjectId(userId),
      contentType,
      content: contentUrl,
      caption: contentType !== 'text' ? caption : '',
      username: user.username,
      photo: user.photo,
      createdAt: new Date(),
    });

    await post.save();
    const io = req.app.get('io');
    if (io) {
      io.emit('newPost', post.toObject());
    } else {
      logger.warn('Socket.IO instance not found', { userId });
    }
    logger.info('Created post', { userId, postId: post._id, contentType });
    res.json(post.toObject());
  } catch (err) {
    logger.error('Failed to create post', { error: err.message, userId: req.body.userId });
    res.status(400).json({ error: err.message || 'Failed to create post' });
  }
});

// Like a post
router.post('/like', authMiddleware, async (req, res) => {
  try {
    const { postId, userId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid post or user ID' });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const userObjectId = mongoose.Types.ObjectId(userId);
    const isLiked = post.likedBy.some((id) => id.equals(userObjectId));
    post.likes = isLiked ? post.likes - 1 : post.likes + 1;
    post.likedBy = isLiked
      ? post.likedBy.filter((id) => !id.equals(userObjectId))
      : [...post.likedBy, userObjectId];

    await post.save();
    const io = req.app.get('io');
    if (io) {
      io.emit('postUpdate', post.toObject());
    }
    logger.info('Liked post', { userId, postId });
    res.json(post.toObject());
  } catch (err) {
    logger.error('Failed to like post', { error: err.message, userId: req.body.userId, postId: req.body.postId });
    res.status(500).json({ error: 'Failed to like post', details: err.message });
  }
});

// Unlike a post
router.post('/unlike', authMiddleware, async (req, res) => {
  try {
    const { postId, userId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid post or user ID' });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const userObjectId = mongoose.Types.ObjectId(userId);
    post.likes = post.likedBy.some((id) => id.equals(userObjectId)) ? post.likes - 1 : post.likes;
    post.likedBy = post.likedBy.filter((id) => !id.equals(userObjectId));

    await post.save();
    const io = req.app.get('io');
    if (io) {
      io.emit('postUpdate', post.toObject());
    }
    logger.info('Unliked post', { userId, postId });
    res.json(post.toObject());
  } catch (err) {
    logger.error('Failed to unlike post', { error: err.message, userId: req.body.userId, postId: req.body.postId });
    res.status(500).json({ error: 'Failed to unlike post', details: err.message });
  }
});

// Comment on a post
router.post('/comment', authMiddleware, async (req, res) => {
  try {
    const { postId, userId, comment } = req.body;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid post or user ID' });
    }
    if (!comment?.trim()) {
      return res.status(400).json({ error: 'Comment cannot be empty' });
    }

    const user = await User.findById(userId).select('username photo');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const newComment = {
      userId: mongoose.Types.ObjectId(userId),
      comment: comment.trim(),
      username: user.username,
      photo: user.photo,
      createdAt: new Date(),
    };
    post.comments.push(newComment);
    await post.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('postUpdate', post.toObject());
    }
    logger.info('Commented on post', { userId, postId, commentLength: comment.length });
    res.json(newComment);
  } catch (err) {
    logger.error('Failed to comment', { error: err.message, userId: req.body.userId, postId: req.body.postId });
    res.status(400).json({ error: 'Failed to comment', details: err.message });
  }
});

module.exports = router;