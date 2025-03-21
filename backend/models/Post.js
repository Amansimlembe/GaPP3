const mongoose = require('mongoose');
const postSchema = new mongoose.Schema({
  userId: String,
  contentType: String, // 'text', 'image', 'video'
  content: String,
  isStory: { type: Boolean, default: false },
  expiresAt: Date,
  likes: { type: Number, default: 0 },
  comments: [{ userId: String, text: String }],
  shares: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});
module.exports = mongoose.model('Post', postSchema);