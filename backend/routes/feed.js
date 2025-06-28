const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Post = require('../models/Post');
const User = require('../models/User');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { authMiddleware } = require('./auth');
const winston = require('winston');
const PDFDocument = require('pdfkit');
const { createCanvas, loadImage } = require('canvas');
const pdfjsLib = require('pdfjs-dist');

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/feed-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/feed-combined.log' }),
  ],
});

// Configure multer for file uploads
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
      'video+audio': ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav'],
    };
    const contentType = req.body.contentType;
    if (!file && contentType !== 'text') {
      logger.warn('Missing file for non-text content', { contentType, userId: req.body.userId });
      cb(new Error(`File required for ${contentType}`));
    } else if (contentType === 'text' || (contentType && allowedTypes[contentType]?.includes(file.mimetype))) {
      cb(null, true);
    } else {
      logger.warn('Invalid file type', { contentType, mimetype: file?.mimetype, userId: req.body.userId });
      cb(new Error(`Invalid file type for ${contentType}`));
    }
  },
}).fields([
  { name: 'content', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
]);

// Retry operation utility
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

// Convert text to image for text posts
const textToImage = async (text) => {
  const canvas = createCanvas(1080, 1920);
  const ctx = canvas.getContext('2d');
  
  // Gradient background
  const gradient = ctx.createLinearGradient(0, 0, 1080, 1920);
  gradient.addColorStop(0, '#4b6cb7');
  gradient.addColorStop(1, '#182848');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1920);

  // Text styling
  ctx.fillStyle = '#ffffff';
  ctx.font = '48px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = text.match(/.{1,50}(\s|$)/g) || [text];
  lines.forEach((line, index) => {
    ctx.fillText(line, 540, 960 + index * 60 - (lines.length * 30));
  });

  return new Promise((resolve) => {
    canvas.toBuffer((err, buf) => {
      if (err) throw err;
      resolve(buf);
    });
  });
};

// Split PDF into pages
const splitPDF = async (pdfBuffer) => {
  const pdf = await pdfjsLib.getDocument({ data: pdfBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push(canvas.toBuffer('image/png'));
  }
  return pages;
};

// Public feed route (no auth required)
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const [posts, totalPosts] = await Promise.all([
      retryOperation(() =>
        Post.find({ isStory: false })
          .select('userId username photo contentType content audioContent caption likes likedBy comments createdAt')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean()
      ),
      retryOperation(() => Post.countDocuments({ isStory: false })),
    ]);

    const processedPosts = await Promise.all(posts.map(async (post) => {
      let contentUrls = [post.content];
      if (post.contentType === 'text') {
        const imageBuffer = await textToImage(post.content);
        const result = await retryOperation(() =>
          new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
              { resource_type: 'image', folder: 'feed', timeout: 30000 },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            );
            uploadStream.end(imageBuffer);
          })
        );
        contentUrls = [result.secure_url];
      } else if (post.contentType === 'raw' && post.content.endsWith('.pdf')) {
        const pdfBuffer = await fetch(post.content).then(res => res.arrayBuffer());
        contentUrls = await splitPDF(pdfBuffer).then(pages => 
          Promise.all(pages.map(page => 
            new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                { resource_type: 'image', folder: 'feed', timeout: 30000 },
                (error, result) => {
                  if (error) reject(error);
                  else resolve(result.secure_url);
                }
              );
              uploadStream.end(page);
            })
          ))
        );
      }
      return {
        ...post,
        _id: post._id.toString(),
        userId: post.userId.toString(),
        content: contentUrls,
        likedBy: post.likedBy.map((id) => id.toString()),
        comments: post.comments.slice(-5).map((comment) => ({
          ...comment,
          userId: comment.userId.toString(),
          createdAt: comment.createdAt.toISOString(),
        })),
        createdAt: post.createdAt.toISOString(),
      };
    }));

    const hasMore = skip + posts.length < totalPosts;
    logger.info('Fetched public feed', { page, limit, postCount: processedPosts.length });
    res.json({ posts: processedPosts, hasMore });
  } catch (err) {
    logger.error('Failed to fetch feed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch feed', details: err.message });
  }
});

// User-specific feed route
router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId) || userId !== req.user.id) {
      logger.warn('Invalid or unauthorized user ID', { userId, authUserId: req.user.id });
      return res.status(400).json({ error: 'Invalid or unauthorized user ID' });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const [posts, totalPosts] = await Promise.all([
      retryOperation(() =>
        Post.find({ userId: mongoose.Types.ObjectId(userId), isStory: false })
          .select('userId username photo contentType content audioContent caption likes likedBy comments createdAt')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean()
      ),
      retryOperation(() => Post.countDocuments({ userId: mongoose.Types.ObjectId(userId), isStory: false })),
    ]);

    const processedPosts = await Promise.all(posts.map(async (post) => {
      let contentUrls = [post.content];
      if (post.contentType === 'text') {
        const imageBuffer = await textToImage(post.content);
        const result = await retryOperation(() =>
          new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
              { resource_type: 'image', folder: 'feed', timeout: 30000 },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            );
            uploadStream.end(imageBuffer);
          })
        );
        contentUrls = [result.secure_url];
      } else if (post.contentType === 'raw' && post.content.endsWith('.pdf')) {
        const pdfBuffer = await fetch(post.content).then(res => res.arrayBuffer());
        contentUrls = await splitPDF(pdfBuffer).then(pages => 
          Promise.all(pages.map(page => 
            new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                { resource_type: 'image', folder: 'feed', timeout: 30000 },
                (error, result) => {
                  if (error) reject(error);
                  else resolve(result.secure_url);
                }
              );
              uploadStream.end(page);
            })
          ))
        );
      }
      return {
        ...post,
        _id: post._id.toString(),
        userId: post.userId.toString(),
        content: contentUrls,
        likedBy: post.likedBy.map((id) => id.toString()),
        comments: post.comments.slice(-5).map((comment) => ({
          ...comment,
          userId: comment.userId.toString(),
          createdAt: comment.createdAt.toISOString(),
        })),
        createdAt: post.createdAt.toISOString(),
      };
    }));

    const hasMore = skip + posts.length < totalPosts;
    logger.info('Fetched user posts', { userId, page, limit, postCount: processedPosts.length });
    res.json({ posts: processedPosts, hasMore });
  } catch (err) {
    logger.error('Failed to fetch user posts', { error: err.message, userId: req.params.userId });
    res.status(500).json({ error: 'Failed to fetch user posts', details: err.message });
  }
});

// Create new post
router.post('/', authMiddleware, upload, async (req, res) => {
  try {
    const { userId, contentType, caption } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId) || userId !== req.user.id) {
      logger.warn('Invalid or unauthorized user ID', { userId, authUserId: req.user.id });
      return res.status(400).json({ error: 'Invalid or unauthorized user ID' });
    }

    const user = await retryOperation(() =>
      User.findById(userId).select('username photo').lean()
    );
    if (!user) {
      logger.warn('User not found', { userId });
      return res.status(404).json({ error: 'User not found' });
    }

    let contentUrls = [];
    let audioUrl = '';
    if (contentType === 'text' && caption?.trim()) {
      const imageBuffer = await textToImage(caption.trim());
      const result = await retryOperation(() =>
        new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { resource_type: 'image', folder: 'feed', timeout: 30000 },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(imageBuffer);
        })
      );
      contentUrls = [result.secure_url];
    } else if (contentType !== 'text' && req.files?.content?.[0]) {
      const uploadOptions = {
        resource_type: contentType === 'video+audio' ? 'video' : contentType,
        folder: 'feed',
        timeout: 30000,
        transformation: contentType === 'video' || contentType === 'video+audio' ? [
          { width: 720, height: 1280, crop: 'fill', quality: 'auto' },
          { format: 'mp4', video_codec: 'h264' }
        ] : contentType === 'image' ? [
          { width: 1080, height: 1080, crop: 'fit', quality: 'auto' }
        ] : null,
      };

      if (contentType === 'raw' && req.files.content[0].mimetype === 'application/pdf') {
        const pages = await splitPDF(req.files.content[0].buffer);
        contentUrls = await Promise.all(pages.map(page => 
          retryOperation(() =>
            new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                { resource_type: 'image', folder: 'feed', timeout: 30000 },
                (error, result) => {
                  if (error) reject(error);
                  else resolve(result.secure_url);
                }
              );
              uploadStream.end(page);
            })
          )
        ));
      } else {
        const result = await retryOperation(() =>
          new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
              uploadOptions,
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            );
            uploadStream.end(req.files.content[0].buffer);
          })
        );
        contentUrls = [result.secure_url];
      }
    } else {
      logger.warn('Missing or invalid content', { userId, contentType });
      return res.status(400).json({ error: 'Missing or invalid content' });
    }

    if (contentType === 'video+audio' && req.files?.audio?.[0]) {
      const audioResult = await retryOperation(() =>
        new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { resource_type: 'video', folder: 'feed', timeout: 30000 },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(req.files.audio[0].buffer);
        })
      );
      audioUrl = audioResult.secure_url;
    }

    const post = new Post({
      userId: new mongoose.Types.ObjectId(userId),
      contentType,
      content: contentUrls,
      audioContent: audioUrl || undefined,
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
      io.to(userId).emit('newPost', postObject);
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

// Like post
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
      io.to(post.userId.toString()).emit('postUpdate', postObject);
      logger.info('Emitted postUpdate for like', { userId, postId });
    }
    logger.info('Liked post', { userId, postId });
    res.json(postObject);
  } catch (err) {
    logger.error('Failed to like post', { error: err.message, userId: req.body.userId, postId: req.body.postId });
    res.status(500).json({ error: 'Failed to like post', details: err.message });
  }
});

// Unlike post
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
      io.to(post.userId.toString()).emit('postUpdate', postObject);
      logger.info('Emitted postUpdate for unlike', { userId, postId });
    }
    logger.info('Unliked post', { userId, postId });
    res.json(postObject);
  } catch (err) {
    logger.error('Failed to unlike post', { error: err.message, userId: req.body.userId, postId: req.body.postId });
    res.status(500).json({ error: 'Failed to unlike post', details: err.message });
  }
});

// Comment on post
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
      io.to(post.userId.toString()).emit('postUpdate', postObject);
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