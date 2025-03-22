const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  senderId: { type: String, required: true },
  recipientId: { type: String, required: true },
  contentType: { type: String, required: true },
  content: { type: String, required: true },
  caption: { type: String },
  status: { type: String, default: 'sent', enum: ['sent', 'delivered', 'read'] },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Message', messageSchema);