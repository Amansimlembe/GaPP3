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
  createdAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: false, // Only use createdAt explicitly
});

// Indexes for performance
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });
messageSchema.index({ recipientId: 1, createdAt: -1 });
messageSchema.index({ status: 1 });

module.exports = mongoose.model('Message', messageSchema);