const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentType: { type: String, required: true },
  content: { type: String, required: true },
  iv: { type: String }, // Added for AES-GCM encryption
  caption: { type: String },
  status: { type: String, default: 'sent' },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  createdAt: { type: Date, default: Date.now }
});

// Add indexes for faster queries
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);