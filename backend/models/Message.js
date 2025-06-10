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
  plaintextContent: { type: String, default: '' },
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  caption: { type: String },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  originalFilename: { type: String },
  clientMessageId: { type: String, required: true, unique: true },
  senderVirtualNumber: { type: String },
  senderUsername: { type: String },
  senderPhoto: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
}, {
  timestamps: { updatedAt: 'updatedAt' },
});

// Indexes for performance
messageSchema.index({ clientMessageId: 1 }, { unique: true });
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, status: 1 });
messageSchema.index({ recipientId: 1, status: 1 });

// Pre-save hook to validate senderId and recipientId
messageSchema.pre('save', async function (next) {
  try {
    const [sender, recipient] = await Promise.all([
      User.findById(this.senderId).select('virtualNumber username photo').lean(),
      User.findById(this.recipientId).select('_id').lean(),
    ]);
    if (!sender || !recipient) {
      logger.error('Invalid sender or recipient', { senderId: this.senderId, recipientId: this.recipientId });
      return next(new Error('Sender or recipient does not exist'));
    }
    // Populate sender details if not provided
    this.senderVirtualNumber = this.senderVirtualNumber || sender.virtualNumber;
    this.senderUsername = this.senderUsername || sender.username;
    this.senderPhoto = this.senderPhoto || sender.photo;
    next();
  } catch (error) {
    logger.error('Message pre-save validation failed', { error: error.message });
    next(error);
  }
});

// Static method to clean up orphaned messages
messageSchema.statics.cleanupOrphanedMessages = async function () {
  try {
    logger.info('Starting orphaned messages cleanup');
    const batchSize = 1000;
    let totalDeleted = 0;

    // Get distinct sender and recipient IDs
    const [senderIds, recipientIds] = await Promise.all([
      this.distinct('senderId'),
      this.distinct('recipientId'),
    ]);
    const messageUsers = [...new Set([...senderIds, ...recipientIds].map(id => id.toString()))];

    if (!messageUsers.length) {
      logger.info('No messages found for cleanup');
      return { deletedCount: 0 };
    }

    // Get existing user IDs
    const existingUsers = await User.find({ _id: { $in: messageUsers } }).select('_id').lean();
    const existingUserIds = new Set(existingUsers.map(user => user._id.toString()));

    // Identify orphaned user IDs
    const orphanedUserIds = messageUsers.filter(id => !existingUserIds.has(id));

    if (!orphanedUserIds.length) {
      logger.info('No orphaned messages found');
      return { deletedCount: 0 };
    }

    // Delete orphaned messages in batches
    const result = await this.deleteMany({
      $or: [
        { senderId: { $in: orphanedUserIds } },
        { recipientId: { $in: orphanedUserIds } },
      ],
    });
    totalDeleted = result.deletedCount;

    logger.info('Orphaned messages cleanup completed', { deletedCount: totalDeleted });
    return { deletedCount: totalDeleted };
  } catch (error) {
    logger.error('Orphaned messages cleanup failed', { error: error.message });
    throw error;
  }
};

module.exports = mongoose.model('Message', messageSchema);