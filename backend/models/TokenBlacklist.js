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
      expires: '30d',
    },
  },
  {
    timestamps: true,
  }
);

tokenBlacklistSchema.index({ token: 1 }, { unique: true });

// Changed: Log duplicate token errors
tokenBlacklistSchema.pre('save', async function (next) {
  try {
    const existing = await this.constructor.findOne({ token: this.token }).lean();
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

// Changed: Method to verify token status
tokenBlacklistSchema.statics.isBlacklisted = async function (token) {
  try {
    const blacklisted = await this.findOne({ token }).lean();
    return !!blacklisted;
  } catch (error) {
    logger.error('Token blacklist check failed', { error: error.message, stack: error.stack });
    return false;
  }
};

module.exports = mongoose.model('TokenBlacklist', tokenBlacklistSchema);