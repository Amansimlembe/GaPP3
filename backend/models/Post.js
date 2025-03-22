const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  contentType: { type: String, required: true },
  content: { type: String, required: true },
  caption: { type: String },
  username: { type: String },
  photo: { type: String },
  likes: { type: Number, default: 0 },
  isStory: { type: Boolean, default: false },
  expiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Post', postSchema);