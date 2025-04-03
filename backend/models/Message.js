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
    required: true, // RSA-encrypted content for text, media URL for others
  },
  plaintextContent: {
    type: String,
    default: '', // Original plaintext for text messages, empty for media
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
    index: true,
  },
  isForwarded: {
    type: Boolean,
    default: false, // Replaces forwardCount for clarity
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
  timestamps: false,
});

// Indexes for performance
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });
messageSchema.index({ recipientId: 1, createdAt: -1 });
messageSchema.index({ status: 1, recipientId: 1, createdAt: -1 }); // Optimized for unread messages
messageSchema.index({ clientMessageId: 1 }, { unique: true, sparse: true });

// Pre-save hook for clientMessageId uniqueness and content validation
messageSchema.pre('save', async function (next) {
  if (this.isNew && this.clientMessageId) {
    const existingMessage = await this.constructor.findOne({ clientMessageId: this.clientMessageId });
    if (existingMessage) {
      return next(new Error('Duplicate clientMessageId detected'));
    }
  }
  if (this.contentType === 'text' && !this.content.startsWith('-----BEGIN ENCRYPTED MESSAGE-----')) {
    return next(new Error('Text content must be RSA-encrypted'));
  }
  next();
});

module.exports = mongoose.model('Message', messageSchema);