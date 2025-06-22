const mongoose = require('mongoose');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/token-blacklist-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/token-blacklist-combined.log' }),
  ],
});

const tokenBlacklistSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 24 * 60 * 60, // Changed: 24 hours (matches JWT expiration)
    },
  },
  {
    timestamps: false, // Changed: Disable timestamps to reduce overhead
  }
);

tokenBlacklistSchema.index({ token: 1 }, { unique: true });

// Changed: Add retry logic for MongoDB operations
const retryOperation = async (operation, maxRetries = 3, baseDelay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      logger.warn('Retrying MongoDB operation', { attempt, error: err.message });
      if (attempt === maxRetries) {
        logger.error('MongoDB operation failed after retries', { error: err.message, stack: err.stack });
        throw err;
      }
      const delay = Math.pow(2, attempt) * baseDelay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Changed: Optimize pre-save hook with retry
tokenBlacklistSchema.pre('save', async function (next) {
  try {
    const existing = await retryOperation(() => 
      this.constructor.findOne({ token: this.token }).lean()
    );
    if (existing) {
      logger.warn('Attempted to blacklist already blacklisted token', { token: this.token.slice(0, 20) + '...' });
      return next(new Error('Token already blacklisted'));
    }
    next();
  } catch (error) {
    logger.error('Token blacklist pre-save failed', { error: error.message, stack: error.stack });
    next(error);
  }
});

// Changed: Optimize isBlacklisted with retry
tokenBlacklistSchema.statics.isBlacklisted = async function (token) {
  try {
    const blacklisted = await retryOperation(() => 
      this.findOne({ token }).lean()
    );
    return !!blacklisted;
  } catch (error) {
    logger.error('Token blacklist check failed', { error: error.message, stack: error.stack });
    return false; // Fail-safe: assume not blacklisted on error
  }
};

// Changed: Add method to clean up expired tokens manually
tokenBlacklistSchema.statics.cleanupExpiredTokens = async function () {
  try {
    const result = await retryOperation(() =>
      this.deleteMany({ createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } })
    );
    logger.info('Expired tokens cleanup completed', { deletedCount: result.deletedCount });
    return result;
  } catch (error) {
    logger.error('Expired tokens cleanup failed', { error: error.message, stack: error.stack });
    throw error;
  }
};

// Changed: Add periodic cleanup index
tokenBlacklistSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

const TokenBlacklist = mongoose.model('TokenBlacklist', tokenBlacklistSchema);

// Changed: Run initial cleanup on startup
TokenBlacklist.cleanupExpiredTokens().catch((err) => {
  logger.error('Initial token blacklist cleanup failed', { error: err.message });
});

// Changed: Periodic cleanup every 6 hours
setInterval(() => {
  TokenBlacklist.cleanupExpiredTokens().catch((err) => {
    logger.error('Periodic token blacklist cleanup failed', { error: err.message });
  });
}, 6 * 60 * 60 * 1000);

module.exports = TokenBlacklist;