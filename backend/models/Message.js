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
  plaintextContent: { type: String },
  status: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed'], default: 'pending' },
  caption: { type: String },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  originalFilename: { type: String },
  clientMessageId: { type: String, unique: true, sparse: true },
  senderVirtualNumber: { type: String },
  senderUsername: { type: String },
  senderPhoto: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

// Indexes for performance
messageSchema.index({ senderId: 1 });
messageSchema.index({ recipientId: 1 });
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 }); // For chat history queries

// Pre-save hook to validate senderId and recipientId
messageSchema.pre('save', async function (next) {
  try {
    const [senderExists, recipientExists] = await Promise.all([
      User.exists({ _id: this.senderId }),
      User.exists({ _id: this.recipientId }),
    ]);
    if (!senderExists || !recipientExists) {
      const error = new Error('Sender or recipient does not exist');
      error.status = 400;
      logger.error('Failed to save message: invalid sender or recipient', {
        senderId: this.senderId,
        recipientId: this.recipientId,
      });
      return next(error);
    }
    this.updatedAt = new Date();
    next();
  } catch (error) {
    logger.error('Error in message pre-save validation', { error: error.message, stack: error.stack });
    next(error);
  }
});

// Static method to clean up orphaned messages
messageSchema.statics.cleanupOrphanedMessages = async function () {
  try {
    logger.info('Starting orphaned messages cleanup');
    const batchSize = 1000;
    let totalDeleted = 0;
    let orphanedUserIds = [];

    // Get distinct sender and recipient IDs in batches
    const getDistinctIds = async (field) => {
      let ids = [];
      let skip = 0;
      while (true) {
        const batch = await this.distinct(field, { [field]: { $nin: ids } })
          .limit(batchSize)
          .skip(skip);
        if (!batch.length) break;
        ids.push(...batch);
        skip += batchSize;
      }
      return ids;
    };

    const [senderIds, recipientIds] = await Promise.all([
      getDistinctIds('senderId'),
      getDistinctIds('recipientId'),
    ]);
    const messageUsers = [...new Set([...senderIds, ...recipientIds].map(id => id.toString()))];

    if (!messageUsers.length) {
      logger.info('No messages found for cleanup');
      return { deletedCount: 0, orphanedUserIds: [] };
    }

    // Get existing user IDs in batches
    const existingUsers = [];
    for (let i = 0; i < messageUsers.length; i += batchSize) {
      const batch = await User.find({
        _id: { $in: messageUsers.slice(i, i + batchSize) },
      }).select('_id');
      existingUsers.push(...batch);
    }
    const existingUserIds = new Set(existingUsers.map(user => user._id.toString()));

    // Identify orphaned user IDs
    orphanedUserIds = messageUsers.filter(id => !existingUserIds.has(id));

    if (!orphanedUserIds.length) {
      logger.info('No orphaned messages found');
      return { deletedCount: 0, orphanedUserIds: [] };
    }

    // Delete orphaned messages in batches
    for (let i = 0; i < orphanedUserIds.length; i += batchSize) {
      const batch = orphanedUserIds.slice(i, i + batchSize);
      const result = await this.deleteMany({
        $or: [
          { senderId: { $in: batch } },
          { recipientId: { $in: batch } },
        ],
      });
      totalDeleted += result.deletedCount;
    }

    logger.info('Orphaned messages cleanup completed', {
      deletedCount: totalDeleted,
      orphanedUserIds: orphanedUserIds.length,
    });

    return { deletedCount: totalDeleted, orphanedUserIds };
  } catch (error) {
    logger.error('Orphaned messages cleanup failed', { error: error.message, stack: error.stack });
    throw error;
  }
};

module.exports = mongoose.model('Message', messageSchema);