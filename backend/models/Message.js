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
    required: true, // Stores RSA-encrypted content or Cloudinary URL
  },
  plaintextContent: {
    type: String,
    default: '', // Stores the original plaintext for text messages, empty for media
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
  },
  originalFilename: {
    type: String,
    trim: true,
    maxlength: 255, // Reasonable limit for filenames
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
    index: true, // Index for quick lookup to prevent duplicates
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
messageSchema.index({ status: 1 }); // For filtering unread messages
messageSchema.index({ clientMessageId: 1 }, { unique: true, sparse: true }); // Prevent duplicates, sparse allows null values

module.exports = mongoose.model('Message', messageSchema);