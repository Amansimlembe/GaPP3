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

const messageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: {
    type: String,
    required: true,
    validate: {
      validator: function (v) {
        if (this.contentType === 'text') {
          return /^[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/.test(v);
        }
        // --- Updated: Relaxed URL validation ---
        return /^(https?:\/\/[^\s/$.?#][^\s]*(\?[^\s]*)?)$/.test(v);
      },
      message: props =>
        props.value.contentType === 'text'
          ? 'Text content must be in encrypted format (data|iv|key)'
          : 'Media content must be a valid URL',
    },
  },
  contentType: { type: String, enum: ['text', 'image', 'video', 'audio', 'document'], required: true },
  plaintextContent: {
    type: String,
    default: '', // --- Updated: Optional with empty string default ---
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'delivered', 'read', 'failed'], // --- Updated: Added pending/failed ---
    default: 'sent',
  },
  caption: { type: String, default: null },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  originalFilename: { type: String, default: null },
  clientMessageId: { type: String, required: false, unique: true, sparse: true }, // --- Updated: Optional, sparse index ---
  senderVirtualNumber: { type: String, default: null },
  senderUsername: { type: String, default: null },
  senderPhoto: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
}, {
  timestamps: { updatedAt: 'updatedAt' },
});

// Consolidated indexes
messageSchema.index({ clientMessageId: 1 }, { unique: true, sparse: true }); // --- Updated: Sparse index ---
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });
messageSchema.index({ recipientId: 1, status: 1 });

// Sender cache
const senderCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Pre-save hook
messageSchema.pre('save', async function (next) {
  try {
    // Validate sender
    const cacheKey = this.senderId.toString();
    let sender = senderCache.get(cacheKey);
    if (!sender || sender.timestamp < Date.now() - CACHE_TTL) {
      sender = await User.findById(this.senderId).select('virtualNumber username photo').lean();
      if (!sender) {
        logger.error('Invalid sender', { senderId: this.senderId });
        return next(new Error('Sender does not exist'));
      }
      senderCache.set(cacheKey, { ...sender, timestamp: Date.now() });
    }

    // --- Updated: Validate recipient ---
    const recipient = await User.findById(this.recipientId).select('_id').lean();
    if (!recipient) {
      logger.error('Invalid recipient', { recipientId: this.recipientId });
      return next(new Error('Recipient does not exist'));
    }

    // Populate sender fields if missing
    this.senderVirtualNumber = this.senderVirtualNumber || sender.virtualNumber || '';
    this.senderUsername = this.senderUsername || sender.username || 'Unknown';
    this.senderPhoto = this.senderPhoto || sender.photo || 'https://placehold.co/40x40';

    // --- Updated: Generate clientMessageId if missing ---
    if (!this.clientMessageId && this.isNew) {
      this.clientMessageId = `server-${this._id}-${Date.now()}`;
      logger.debug('Generated clientMessageId', { clientMessageId: this.clientMessageId });
    }

    // Validate replyTo if present
    if (this.replyTo) {
      const replyMessage = await this.constructor.findById(this.replyTo).select('_id').lean();
      if (!replyMessage) {
        logger.error('Invalid replyTo ID', { replyTo: this.replyTo });
        return next(new Error('ReplyTo message does not exist'));
      }
    }

    // --- Updated: Ensure plaintextContent is string ---
    if (this.plaintextContent === undefined || this.plaintextContent === null) {
      this.plaintextContent = '';
    }

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
    let processedUsers = 0;

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
      processedUsers += batch.length;
      logger.debug('Processed user batch', { processed: processedUsers, total: messageUsers.length });
    }

    const orphanedUserIds = messageUsers.filter(id => !existingUserIds.has(id));

    if (!orphanedUserIds.length) {
      logger.info('No orphaned messages found');
      return { deletedCount: 0 };
    }

    for (let i = 0; i < orphanedUserIds.length; i += batchSize) {
      const batch = orphanedUserIds.slice(i, i + batchSize);
      const result = await this.deleteMany({
        $or: [
          { senderId: { $in: batch } },
          { recipientId: { $in: batch } },
        ],
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