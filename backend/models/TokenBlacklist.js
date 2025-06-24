
const mongoose = require('mongoose');
const winston = require('winston');

// Logger configuration with deduplication
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
    winston.format((info) => {
      const errorKey = `${info.error}:${info.token || 'unknown'}`;
      info.errorCount = logger.errorCounts.get(errorKey) || 0;
      if (info.level === 'error' && info.errorCount >= 2) return false;
      logger.errorCounts.set(errorKey, info.errorCount + 1);
      setTimeout(() => logger.errorCounts.delete(errorKey), 60 * 1000);
      return info;
    })()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/token-blacklist-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/token-blacklist-combined.log' }),
  ],
  errorCounts: new Map(),
});

const tokenBlacklistSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
      index: true, // Explicit index for faster lookups
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 24 * 60 * 60, // 24 hours (matches JWT expiration)
    },
  },
  {
    timestamps: false, // Disable timestamps to reduce overhead
  }
);

// Explicit index for token lookups
tokenBlacklistSchema.index({ token: 1 }, { unique: true, name: 'token_unique_idx' });

// Retry logic for MongoDB operations
const retryOperation = async (operation, maxRetries = 3, baseDelay = 2000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      logger.warn('Retrying MongoDB operation', { attempt, error: err.message, stack: err.stack });
      if (attempt === maxRetries) {
        logger.error('MongoDB operation failed after retries', { error: err.message, stack: err.stack });
        throw err;
      }
      const delay = Math.pow(2, attempt) * baseDelay; // Exponential backoff: 2s, 4s, 8s
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Pre-save hook with retry and optimized token truncation
tokenBlacklistSchema.pre('save', async function (next) {
  try {
    const existing = await retryOperation(() =>
      this.constructor.findOne({ token: this.token }).lean()
    );
    if (existing) {
      logger.warn('Attempted to blacklist already blacklisted token', {
        token: this.token.slice(0, 20) + '...',
      });
      return next(new Error('Token already blacklisted'));
    }
    next();
  } catch (error) {
    logger.error('Token blacklist pre-save failed', {
      error: error.message,
      stack: error.stack,
      token: this.token.slice(0, 20) + '...',
    });
    next(error);
  }
});

// Optimized isBlacklisted with retry and caching
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const tokenCache = new Map();

tokenBlacklistSchema.statics.isBlacklisted = async function (token) {
  try {
    const cacheKey = `blacklist:${token}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.timestamp > Date.now() - TOKEN_CACHE_TTL) {
      logger.info('Served blacklisted token check from cache', {
        token: token.slice(0, 20) + '...',
        isBlacklisted: cached.isBlacklisted,
      });
      return cached.isBlacklisted;
    }

    const blacklisted = await retryOperation(() =>
      this.findOne({ token }).lean()
    );
    const isBlacklisted = !!blacklisted;

    tokenCache.set(cacheKey, { isBlacklisted, timestamp: Date.now() });
    if (tokenCache.size > 1000) {
      const oldestKey = tokenCache.keys().next().value;
      tokenCache.delete(oldestKey);
    }

    logger.info('Checked token blacklist status', {
      token: token.slice(0, 20) + '...',
      isBlacklisted,
    });
    return isBlacklisted;
  } catch (error) {
    logger.error('Token blacklist check failed', {
      error: error.message,
      stack: error.stack,
      token: token.slice(0, 20) + '...',
    });
    return false; // Fail-safe: assume not blacklisted on error
  }
};

// Cleanup expired tokens manually
tokenBlacklistSchema.statics.cleanupExpiredTokens = async function () {
  try {
    const result = await retryOperation(() =>
      this.deleteMany({ createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } })
    );
    logger.info('Expired tokens cleanup completed', { deletedCount: result.deletedCount });
    tokenCache.clear(); // Clear cache after cleanup
    return result;
  } catch (error) {
    logger.error('Expired tokens cleanup failed', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
};

// TTL index for automatic cleanup
tokenBlacklistSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 24 * 60 * 60, name: 'createdAt_ttl_idx' }
);

const TokenBlacklist = mongoose.model('TokenBlacklist', tokenBlacklistSchema);

// Initial cleanup on startup
TokenBlacklist.cleanupExpiredTokens().catch((err) => {
  logger.error('Initial token blacklist cleanup failed', { error: err.message });
});

// Periodic cleanup every 12 hours (reduced frequency)
setInterval(() => {
  TokenBlacklist.cleanupExpiredTokens().catch((err) => {
    logger.error('Periodic token blacklist cleanup failed', { error: err.message });
  });
}, 12 * 60 * 60 * 1000);

module.exports = TokenBlacklist;