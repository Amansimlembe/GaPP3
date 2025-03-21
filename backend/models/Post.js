const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  contentType: { type: String, enum: ['text', 'image', 'video'] },
  content: String,
  isStory: { type: Boolean, default: false },
  createdAt: Date,
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [{ userId: mongoose.Schema.Types.ObjectId, text: String }],
});

module.exports = mongoose.model('Post', postSchema);