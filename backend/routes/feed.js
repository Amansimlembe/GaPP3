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

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
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

const retryOperation = async (operation, maxRetries = 3, baseDelay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      logger.warn('Retrying operation', { attempt, error: err.message });
      if (attempt === maxRetries) {
        logger.error('Operation failed after retries', { error: err.message, stack: err.stack });
        throw err;
      }
      const delay = Math.pow(2, attempt) * baseDelay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Changed: Optimized GET /feed with indexing and user-specific data
router.get('/', authMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const [posts, totalPosts] = await Promise.all([
      retryOperation(() =>
        Post.find({ isStory: false })
          .select('userId username photo contentType content caption likes likedBy comments createdAt') // Changed: Explicit fields
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean()
      ),
      retryOperation(() => Post.countDocuments({ isStory: false })),
    ]);

    // Changed: Ensure userId and likedBy are strings, limit comments
    const processedPosts = posts.map((post) => ({
      ...post,
      _id: post._id.toString(),
      userId: post.userId.toString(),
      likedBy: post.likedBy.map((id) => id.toString()),
      comments: post.comments.slice(-5).map((comment) => ({
        ...comment,
        userId: comment.userId.toString(),
        createdAt: comment.createdAt.toISOString(),
      })),
      createdAt: post.createdAt.toISOString(),
    }));

    const hasMore = skip + posts.length < totalPosts;
    logger.info('Fetched feed', { userId: req.user.id, page, limit, postCount: processedPosts.length });
    res.json({ posts: processedPosts, hasMore });
  } catch (err) {
    logger.error('Failed to fetch feed', { error: err.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to fetch feed', details: err.message });
  }
});

// Changed: Enhanced POST /feed with validation and socket room targeting
router.post('/', authMiddleware, upload.single('content'), async (req, res) => {
  try {
    const { userId, contentType, caption } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId) || userId !== req.user.id) {
      return res.status(400).json({ error: 'Invalid or unauthorized user ID' });
    }

    const user = await retryOperation(() =>
      User.findById(userId).select('username photo').lean()
    );
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let contentUrl = '';
    if (contentType !== 'text' && req.file) {
      const uploadOptions = {
        resource_type: contentType,
        folder: 'feed',
        timeout: 30000,
        transformation: contentType === 'video' ? [
          { width: 720, height: 1280, crop: 'fill', quality: 'auto' },
          { format: 'mp4', video_codec: 'h264' }
        ] : contentType === 'image' ? [
          { width: 1080, height: 1080, crop: 'fit', quality: 'auto' }
        ] : null,
      };

      const result = await retryOperation(() =>
        new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            uploadOptions,
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          req.file.stream.pipe(uploadStream);
        })
      );

      contentUrl = result.secure_url;
    } else if (contentType === 'text' && caption?.trim()) {
      contentUrl = caption.trim();
    } else {
      return res.status(400).json({ error: 'Missing or invalid content' });
    }

    const post = new Post({
      userId: mongoose.Types.ObjectId(userId),
      contentType,
      content: contentUrl,
      caption: contentType !== 'text' ? caption?.trim() || '' : '',
      username: user.username,
      photo: user.photo,
      isStory: false,
      createdAt: new Date(),
    });

    await retryOperation(() => post.save());
    const postObject = {
      ...post.toObject(),
      _id: post._id.toString(),
      userId: post.userId.toString(),
      likedBy: post.likedBy.map((id) => id.toString()),
      comments: post.comments.map((comment) => ({
        ...comment,
        userId: comment.userId.toString(),
        createdAt: comment.createdAt.toISOString(),
      })),
      createdAt: post.createdAt.toISOString(),
    };

    const io = req.app.get('io');
    if (io) {
      io.to(userId).emit('newPost', postObject); // Changed: Emit to user's room
      logger.info('Emitted newPost', { userId, postId: post._id });
    } else {
      logger.warn('Socket.IO instance not found', { userId });
    }
    logger.info('Created post', { userId, postId: post._id, contentType });
    res.json(postObject);
  } catch (err) {
    logger.error('Failed to create post', { error: err.message, userId: req.body.userId });
    res.status(400).json({ error: 'Failed to create post', details: err.message });
  }
});

// Changed: Optimized POST /like with socket room targeting
router.post('/like', authMiddleware, async (req, res) => {
  try {
    const { postId, userId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(userId) || userId !== req.user.id) {
      return res.status(400).json({ error: 'Invalid or unauthorized post/user ID' });
    }

    const post = await retryOperation(() => Post.findById(postId));
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const userObjectId = mongoose.Types.ObjectId(userId);
    const isLiked = post.likedBy.some((id) => id.equals(userObjectId));
    post.likes = isLiked ? post.likes - 1 : post.likes + 1;
    post.likedBy = isLiked
      ? post.likedBy.filter((id) => !id.equals(userObjectId))
      : [...post.likedBy, userObjectId];

    await retryOperation(() => post.save());
    const postObject = {
      ...post.toObject(),
      _id: post._id.toString(),
      userId: post.userId.toString(),
      likedBy: post.likedBy.map((id) => id.toString()),
      comments: post.comments.map((comment) => ({
        ...comment,
        userId: comment.userId.toString(),
        createdAt: comment.createdAt.toISOString(),
      })),
      createdAt: post.createdAt.toISOString(),
    };

    const io = req.app.get('io');
    if (io) {
      io.to(post.userId.toString()).emit('postUpdate', postObject); // Changed: Emit to post owner's room
      logger.info('Emitted postUpdate for like', { userId, postId });
    }
    logger.info('Liked post', { userId, postId });
    res.json(postObject);
  } catch (err) {
    logger.error('Failed to like post', { error: err.message, userId: req.body.userId, postId: req.body.postId });
    res.status(500).json({ error: 'Failed to like post', details: err.message });
  }
});

// Changed: Optimized POST /unlike with socket room targeting
router.post('/unlike', authMiddleware, async (req, res) => {
  try {
    const { postId, userId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(userId) || userId !== req.user.id) {
      return res.status(400).json({ error: 'Invalid or unauthorized post/user ID' });
    }

    const post = await retryOperation(() => Post.findById(postId));
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const userObjectId = mongoose.Types.ObjectId(userId);
    post.likes = post.likedBy.some((id) => id.equals(userObjectId)) ? post.likes - 1 : post.likes;
    post.likedBy = post.likedBy.filter((id) => !id.equals(userObjectId));

    await retryOperation(() => post.save());
    const postObject = {
      ...post.toObject(),
      _id: post._id.toString(),
      userId: post.userId.toString(),
      likedBy: post.likedBy.map((id) => id.toString()),
      comments: post.comments.map((comment) => ({
        ...comment,
        userId: comment.userId.toString(),
        createdAt: comment.createdAt.toISOString(),
      })),
      createdAt: post.createdAt.toISOString(),
    };

    const io = req.app.get('io');
    if (io) {
      io.to(post.userId.toString()).emit('postUpdate', postObject); // Changed: Emit to post owner's room
      logger.info('Emitted postUpdate for unlike', { userId, postId });
    }
    logger.info('Unliked post', { userId, postId });
    res.json(postObject);
  } catch (err) {
    logger.error('Failed to unlike post', { error: err.message, userId: req.body.userId, postId: req.body.postId });
    res.status(500).json({ error: 'Failed to unlike post', details: err.message });
  }
});

// Changed: Enhanced POST /comment with socket room targeting
router.post('/comment', authMiddleware, async (req, res) => {
  try {
    const { postId, userId, comment } = req.body;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(userId) || userId !== req.user.id) {
      return res.status(400).json({ error: 'Invalid or unauthorized post/user ID' });
    }
    if (!comment?.trim() || comment.length > 500) {
      return res.status(400).json({ error: 'Comment must be non-empty and under 500 characters' });
    }

    const [user, post] = await Promise.all([
      retryOperation(() => User.findById(userId).select('username photo').lean()),
      retryOperation(() => Post.findById(postId)),
    ]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
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
    if (post.comments.length > 100) {
      post.comments.shift();
    }

    await retryOperation(() => post.save());
    const postObject = {
      ...post.toObject(),
      _id: post._id.toString(),
      userId: post.userId.toString(),
      likedBy: post.likedBy.map((id) => id.toString()),
      comments: post.comments.map((comment) => ({
        ...comment,
        userId: comment.userId.toString(),
        createdAt: comment.createdAt.toISOString(),
      })),
      createdAt: post.createdAt.toISOString(),
    };

    const io = req.app.get('io');
    if (io) {
      io.to(post.userId.toString()).emit('postUpdate', postObject); // Changed: Emit to post owner's room
      logger.info('Emitted postUpdate for comment', { userId, postId });
    }
    logger.info('Commented on post', { userId, postId, commentLength: comment.length });
    res.json({
      ...newComment,
      userId: newComment.userId.toString(),
      createdAt: newComment.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error('Failed to comment', { error: err.message, userId: req.body.userId, postId: req.body.postId });
    res.status(400).json({ error: 'Failed to comment', details: err.message });
  }
});

module.exports = router;