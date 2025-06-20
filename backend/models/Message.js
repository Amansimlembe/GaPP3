
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
  content: { type: String, required: true },
  contentType: { type: String, enum: ['text', 'image', 'video', 'audio', 'document'], required: true },
  plaintextContent: {
    type: String,
    required: function () { return this.contentType === 'text'; },
    default: function () { return this.contentType === 'text' ? undefined : ''; },
  },
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  caption: { type: String },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  originalFilename: { type: String },
  clientMessageId: { type: String, required: true, unique: true, index: true },
  senderVirtualNumber: { type: String },
  senderUsername: { type: String },
  senderPhoto: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
}, {
  timestamps: { updatedAt: 'updatedAt' },
});

// Indexes for performance
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, status: 1 });
messageSchema.index({ recipientId: 1, status: 1 });
messageSchema.index({ senderId: 1, recipientId: 1, status: 1 });

// Pre-save hook to validate senderId and recipientId
messageSchema.pre('save', async function (next) {
  try {
    // Only fetch sender data if fields are missing
    if (!this.senderVirtualNumber || !this.senderUsername || !this.senderPhoto) {
      const sender = await User.findById(this.senderId).select('virtualNumber username photo').lean();
      if (!sender) {
        logger.error('Invalid sender', { senderId: this.senderId });
        return next(new Error('Sender does not exist'));
      }
      this.senderVirtualNumber = this.senderVirtualNumber || sender.virtualNumber || '';
      this.senderUsername = this.senderUsername || sender.username || 'Unknown';
      this.senderPhoto = this.senderPhoto || sender.photo || 'https://placehold.co/40x40';
    }

    // Validate recipient exists
    const recipient = await User.findById(this.recipientId).select('_id').lean();
    if (!recipient) {
      logger.error('Invalid recipient', { recipientId: this.recipientId });
      return next(new Error('Recipient does not exist'));
    }

    // Validate replyTo if present
    if (this.replyTo && !mongoose.isValidObjectId(this.replyTo)) {
      logger.error('Invalid replyTo ID', { replyTo: this.replyTo });
      return next(new Error('Invalid replyTo ID'));
    }

    next();
  } catch (error) {
    logger.error('Message pre-save validation failed', {
      error: error.message,
      senderId: this.senderId,
      recipientId: this.recipientId,
    });
    next(error);
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

    for (let i = 0; i < orphanedUserIds.length; i += batchSize) {
      const batch = orphanedUserIds.slice(i, i + batchSize);
      const result = await this.deleteMany({
        $or: [
          { senderId: { $in: batch } },
          { recipientId: { $in: batch } },
        ],
      });
      totalDeleted += result.deletedCount || 0;
    }

    logger.info('Orphaned messages cleanup completed', { deletedCount: totalDeleted });
    return { deletedCount: totalDeleted };
  } catch (error) {
    logger.error('Orphaned messages cleanup failed', { error: error.message });
    throw error;
  }
};

const Message = mongoose.model('Message', messageSchema);
module.exports = Message;
