const mongoose = require('mongoose');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/post-error.log', level: 'error' }), // Changed: Add error log
    new winston.transports.File({ filename: 'logs/post-combined.log' }),
  ],
});

const postSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    contentType: { type: String, required: true, enum: ['text', 'image', 'video', 'audio', 'raw'] },
    content: { type: String, required: true },
    caption: { type: String, trim: true, maxlength: 500 }, // Changed: Add trim and max length
    username: { type: String, required: true, trim: true }, // Changed: Require and trim
    photo: { type: String },
    likes: { type: Number, default: 0, min: 0 }, // Changed: Add min validation
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    comments: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      comment: { type: String, required: true, trim: true, maxlength: 500 }, // Changed: Add trim and max length
      username: { type: String, required: true, trim: true }, // Changed: Require and trim
      photo: { type: String },
      createdAt: { type: Date, default: Date.now },
    }],
    isStory: { type: Boolean, default: false },
    expiresAt: { type: Date }, // For stories
    createdAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false, // Changed: Disable timestamps to avoid redundancy
    indexes: [
      { key: { isStory: 1, createdAt: -1 } }, // For GET /feed
      { key: { userId: 1, createdAt: -1 } }, // Changed: Optimize user-specific queries
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 }, // Changed: TTL index for stories
    ],
  }
);

// Changed: Validate unique likedBy entries
postSchema.pre('save', async function (next) {
  try {
    if (this.isModified('likedBy')) {
      const uniqueLikedBy = [...new Set(this.likedBy.map(id => id.toString()))].map(id => 
        mongoose.Types.ObjectId(id)
      );
      if (uniqueLikedBy.length !== this.likedBy.length) {
        logger.warn('Duplicate likedBy entries detected', { postId: this._id });
        this.likedBy = uniqueLikedBy;
      }
      this.likes = this.likedBy.length; // Ensure likes count matches
    }

    // Changed: Set expiresAt for stories
    if (this.isStory && !this.expiresAt) {
      this.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    }

    // Changed: Limit comments to 100
    if (this.comments.length > 100) {
      this.comments = this.comments.slice(-100); // Keep newest 100
      logger.info('Truncated comments to 100', { postId: this._id });
    }

    next();
  } catch (error) {
    logger.error('Post pre-save failed', { error: error.message, stack: error.stack, postId: this._id });
    next(error);
  }
});

// Changed: Method to clean up orphaned posts
postSchema.statics.cleanupOrphanedPosts = async function () {
  try {
    const result = await this.deleteMany({
      $or: [
        { userId: { $exists: false } },
        { userId: null },
        { userId: { $not: { $type: 'objectId' } } },
      ],
    });
    logger.info('Orphaned posts cleanup completed', { deletedCount: result.deletedCount });
    return result;
  } catch (error) {
    logger.error('Orphaned posts cleanup failed', { error: error.message, stack: error.stack });
    throw error;
  }
};

// Changed: Run initial cleanup on startup
const Post = mongoose.model('Post', postSchema);
Post.cleanupOrphanedPosts().catch((err) => {
  logger.error('Initial orphaned posts cleanup failed', { error: err.message });
});

// Changed: Periodic cleanup every 6 hours
setInterval(() => {
  Post.cleanupOrphanedPosts().catch((err) => {
    logger.error('Periodic orphaned posts cleanup failed', { error: err.message });
  });
}, 6 * 60 * 60 * 1000);

module.exports = Post;