const mongoose = require('mongoose');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/post-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/post-combined.log' }),
  ],
});

const postSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    contentType: { type: String, required: true, enum: ['text', 'image', 'video', 'audio', 'raw', 'video+audio'] },
    content: [{ type: String, required: true }], // Changed to array to support multiple URLs (e.g., PDF pages)
    audioContent: { type: String }, // For audio in video+audio posts
    caption: { type: String, trim: true, maxlength: 500 },
    username: { type: String, required: true, trim: true },
    photo: { type: String },
    likes: { type: Number, default: 0, min: 0 },
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    comments: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      comment: { type: String, required: true, trim: true, maxlength: 500 },
      username: { type: String, required: true, trim: true },
      photo: { type: String },
      createdAt: { type: Date, default: Date.now },
    }],
    isStory: { type: Boolean, default: false },
    expiresAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
    indexes: [
      { key: { isStory: 1, createdAt: -1 } },
      { key: { userId: 1, createdAt: -1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
  }
);

postSchema.pre('save', async function (next) {
  try {
    // Ensure unique likedBy entries and sync likes count
    if (this.isModified('likedBy')) {
      const uniqueLikedBy = [...new Set(this.likedBy.map(id => id.toString()))].map(id => 
        mongoose.Types.ObjectId.createFromHexString(id)
      );
      if (uniqueLikedBy.length !== this.likedBy.length) {
        logger.warn('Duplicate likedBy entries detected', { postId: this._id });
        this.likedBy = uniqueLikedBy;
      }
      this.likes = this.likedBy.length;
    }

    // Validate content array
    if (!this.content || !Array.isArray(this.content) || this.content.length === 0) {
      const error = new Error('Content array cannot be empty');
      logger.error('Invalid content array', { postId: this._id, content: this.content });
      return next(error);
    }

    // Ensure text posts have a single content URL (image) and no caption
    if (this.contentType === 'text' && this.content.length !== 1) {
      const error = new Error('Text posts must have exactly one content URL');
      logger.error('Invalid text post content', { postId: this._id, contentLength: this.content.length });
      return next(error);
    }
    if (this.contentType === 'text' && this.caption) {
      this.caption = '';
      logger.info('Cleared caption for text post', { postId: this._id });
    }

    // Ensure story expiration
    if (this.isStory && !this.expiresAt) {
      this.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }

    // Limit comments to 100
    if (this.comments.length > 100) {
      this.comments = this.comments.slice(-100);
      logger.info('Truncated comments to 100', { postId: this._id });
    }

    // Validate contentType-specific requirements
    if (this.contentType === 'video+audio' && !this.audioContent) {
      const error = new Error('video+audio posts require an audioContent URL');
      logger.error('Missing audioContent for video+audio post', { postId: this._id });
      return next(error);
    }

    if (this.contentType === 'raw' && this.content.some(url => !url.endsWith('.png'))) {
      logger.warn('Raw content URLs should be PNG images for PDF pages', { postId: this._id });
    }

    next();
  } catch (error) {
    logger.error('Post pre-save failed', { error: error.message, stack: error.stack, postId: this._id });
    next(error);
  }
});

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

const Post = mongoose.model('Post', postSchema);
Post.cleanupOrphanedPosts().catch((err) => {
  logger.error('Initial orphaned posts cleanup failed', { error: err.message });
});

setInterval(() => {
  Post.cleanupOrphanedPosts().catch((err) => {
    logger.error('Periodic orphaned posts cleanup failed', { error: err.message });
  });
}, 6 * 60 * 60 * 1000);

module.exports = Post;