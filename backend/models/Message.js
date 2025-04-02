const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  contentType: {
    type: String,
    required: true,
    enum: ['text', 'image', 'video', 'audio', 'document'],
  },
  content: {
    type: String,
    required: true, // Stores RSA-encrypted content or media URL
  },
  plaintextContent: {
    type: String,
    default: '', // Stores original plaintext for text messages, empty for media
  },
  caption: {
    type: String,
    trim: true,
    maxlength: 500,
  },
  status: {
    type: String,
    enum: ['sent', 'delivered', 'read'],
    default: 'sent',
  },
  replyTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null,
  },
  originalFilename: {
    type: String,
    trim: true,
    maxlength: 255,
    default: null,
  },
  senderVirtualNumber: {
    type: String,
    trim: true,
  },
  senderUsername: {
    type: String,
    trim: true,
  },
  senderPhoto: {
    type: String,
    trim: true,
  },
  clientMessageId: {
    type: String,
    trim: true,
    index: true, // Index for deduplication lookups
  },
  forwardCount: {
    type: Number,
    default: 0,
    min: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: false, // Only use createdAt explicitly
});

// Indexes for performance
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 }); // For fetching messages by sender/recipient
messageSchema.index({ recipientId: 1, createdAt: -1 }); // For recipient message lists
messageSchema.index({ status: 1, createdAt: -1 }); // For filtering unread messages efficiently
messageSchema.index({ clientMessageId: 1 }, { unique: true, sparse: true }); // Prevent duplicates, sparse allows null

// Pre-save hook to ensure clientMessageId uniqueness
messageSchema.pre('save', async function (next) {
  if (this.clientMessageId && this.isNew) {
    const existingMessage = await this.constructor.findOne({ clientMessageId: this.clientMessageId });
    if (existingMessage) {
      return next(new Error('Duplicate clientMessageId detected'));
    }
  }
  next();
});

module.exports = mongoose.model('Message', messageSchema);