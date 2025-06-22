const mongoose = require('mongoose');
const User = require('./User');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/message-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/message-combined.log' }),
  ],
});

// Changed: Add TTL index for 30 days
const MESSAGE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const messageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: {
    type: String,
    required: true,
    validate: {
      validator: function (v) {
        if (this.contentType === 'text') {
          return v === '' || /^[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/.test(v);
        }
        return v === '' || /^(https?:\/\/[^\s/$.?#][^\s]*)$/.test(v);
      },
      message: props =>
        props.value.contentType === 'text'
          ? 'Text content must be empty or in encrypted format (data|iv|key)'
          : 'Media content must be empty or a valid URL',
    },
  },
  contentType: { type: String, enum: ['text', 'image', 'video', 'audio', 'document'], required: true },
  plaintextContent: { type: String, default: '' },
  status: {
    type: String,
    enum: ['pending', 'sent', 'delivered', 'read', 'failed'],
    default: 'pending',
  },
  caption: { type: String, default: null, maxLength: 500 }, // Changed: Add maxLength
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  originalFilename: { type: String, default: null, maxLength: 255 }, // Changed: Add maxLength
  clientMessageId: { type: String, required: true, unique: true, sparse: true },
  senderVirtualNumber: { type: String, default: null },
  senderUsername: { type: String, default: null, maxLength: 50 }, // Changed: Add maxLength
  senderPhoto: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: MESSAGE_TTL_SECONDS }, // Changed: Add TTL
  updatedAt: { type: Date },
}, {
  timestamps: { updatedAt: 'updatedAt' },
});

// Changed: Optimized indexes
messageSchema.index({ clientMessageId: 1 }, { unique: true, sparse: true });
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });
messageSchema.index({ recipientId: 1, status: 1 });
messageSchema.index({ createdAt: 1 }); // Changed: Support TTL

// Changed: Bounded LRU cache
class LRUCache {
  constructor(maxSize, ttl) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
  }
  get(key) {
    const item = this.cache.get(key);
    if (item && item.timestamp > Date.now() - this.ttl) {
      this.cache.delete(key);
      this.cache.set(key, item);
      return item.data;
    }
    this.cache.delete(key);
    return null;
  }
  set(key, data) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}

const senderCache = new LRUCache(1000, 5 * 60 * 1000); // Changed: 1000 users, 5 min TTL

// Changed: Retry with exponential backoff
const retryOperation = async (operation, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn('Retrying operation', { attempt, error: err.message });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Pre-save hook
messageSchema.pre('save', async function (next) {
  try {
    await retryOperation(async () => {
      const cacheKey = this.senderId.toString();
      let sender = senderCache.get(cacheKey);
      if (!sender) {
        sender = await User.findById(this.senderId).select('virtualNumber username photo').lean();
        if (!sender) {
          throw new Error('Sender does not exist');
        }
        senderCache.set(cacheKey, sender);
      }

      const recipient = await User.findById(this.recipientId).select('_id status').lean();
      if (!recipient) {
        throw new Error('Recipient does not exist');
      }

      this.senderVirtualNumber = this.senderVirtualNumber || sender.virtualNumber || '';
      this.senderUsername = this.senderUsername || sender.username || 'Unknown';
      this.senderPhoto = this.senderPhoto || sender.photo || 'https://placehold.co/40x40';

      if (this.isNew && !this.status) {
        this.status = recipient.status === 'online' ? 'delivered' : 'pending';
      }

      if (this.replyTo) {
        const replyMessage = await this.constructor.findById(this.replyTo).select('_id').lean();
        if (!replyMessage) {
          throw new Error('ReplyTo message does not exist');
        }
      }

      if (this.plaintextContent === undefined || this.plaintextContent === null) {
        this.plaintextContent = '';
      }
    });
    next();
  } catch (error) {
    logger.error('Message pre-save validation failed', {
      error: error.message,
      senderId: this.senderId,
      recipientId: this.recipientId,
      stack: error.stack,
    });
    next(new Error(`Message validation failed: ${error.message}`));
  }
});

// Static method to clean up orphaned messages
messageSchema.statics.cleanupOrphanedMessages = async function () {
  try {
    logger.info('Starting orphaned messages cleanup');
    const batchSize = 1000;
    let totalDeleted = 0;

    const [senderIds, recipientIds] = await Promise.all([
      this.distinct('senderId'),
      this.distinct('recipientId'),
    ]);
    const messageUsers = [...new Set([...senderIds, ...recipientIds].map(id => id.toString()))];

    if (!messageUsers.length) {
      logger.info('No messages found for cleanup');
      return { deletedCount: 0 };
    }

    const existingUserIds = new Set();
    for (let i = 0; i < messageUsers.length; i += batchSize) {
      const batch = messageUsers.slice(i, i + batchSize);
      const users = await User.find({ _id: { $in: batch } }).select('_id').lean();
      users.forEach(user => existingUserIds.add(user._id.toString()));
    }

    const orphanedUserIds = messageUsers.filter(id => !existingUserIds.has(id));
    if (!orphanedUserIds.length) {
      logger.info('No orphaned messages found');
      return { deletedCount: 0 };
    }

    // Changed: Use retry for deletion
    for (let i = 0; i < orphanedUserIds.length; i += batchSize) {
      const batch = orphanedUserIds.slice(i, i + batchSize);
      const result = await retryOperation(async () => {
        const deleteResult = await this.deleteMany({
          $or: [
            { senderId: { $in: batch } },
            { recipientId: { $in: batch } },
          ],
        });
        return deleteResult;
      });
      totalDeleted += result.deletedCount || 0;
      logger.debug('Deleted orphaned messages batch', { deleted: result.deletedCount, batchSize: batch.length });
    }

    logger.info('Orphaned messages cleanup completed', { deletedCount: totalDeleted });
    return { deletedCount: totalDeleted };
  } catch (error) {
    logger.error('Orphaned messages cleanup failed', { error: error.message, stack: error.stack });
    throw new Error(`Cleanup failed: ${error.message}`);
  }
};

const Message = mongoose.model('Message', messageSchema);
module.exports = Message;