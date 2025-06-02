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
  clientMessageId: { type: String, unique: true },
  senderVirtualNumber: { type: String },
  senderUsername: { type: String },
  senderPhoto: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

// Indexes for performance
messageSchema.index({ senderId: 1 });
messageSchema.index({ recipientId: 1 });

// Static method to clean up orphaned messages
messageSchema.statics.cleanupOrphanedMessages = async function () {
  try {
    logger.info('Starting orphaned messages cleanup');

    // Get all unique sender and recipient IDs from messages
    const messageUsers = await this.aggregate([
      {
        $group: {
          _id: null,
          senderIds: { $addToSet: '$senderId' },
          recipientIds: { $addToSet: '$recipientId' },
        },
      },
    ]);

    if (!messageUsers.length) {
      logger.info('No messages found');
      return { deletedCount: 0, orphanedUserIds: 0 };
    }

    const { senderIds, recipientIds } = messageUsers[0];
    const allMessageUserIds = [...new Set([...senderIds, ...recipientIds])];

    // Get existing user IDs
    const existingUsers = await User.find({ _id: { $in: allMessageUserIds } }).select('_id');
    const existingUserIds = new Set(existingUsers.map(user => user._id.toString()));

    // Identify orphaned messages
    const orphanedUserIds = allMessageUserIds.filter(id => !existingUserIds.has(id.toString()));

    if (orphanedUserIds.length === 0) {
      logger.info('No orphaned messages found');
      return { deletedCount: 0, orphanedUserIds: 0 };
    }

    // Delete messages with non-existent sender or recipient
    const result = await this.deleteMany({
      $or: [
        { senderId: { $in: orphanedUserIds } },
        { recipientId: { $in: orphanedUserIds } },
      ],
    });

    logger.info('Orphaned messages cleanup completed', {
      deletedCount: result.deletedCount,
      orphanedUserIds: orphanedUserIds.length,
    });

    return { deletedCount: result.deletedCount, orphanedUserIds: orphanedUserIds.length };
  } catch (error) {
    logger.error('Orphaned messages cleanup failed', { error: error.message, stack: error.stack });
    throw error;
  }
};

module.exports = mongoose.model('Message', messageSchema);