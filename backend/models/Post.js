const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  contentType: { type: String, required: true, enum: ['text', 'image', 'video', 'audio', 'raw'] },
  content: { type: String, required: true },
  caption: { type: String },
  username: { type: String },
  photo: { type: String },
  likes: { type: Number, default: 0 },
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    comment: { type: String, required: true },
    username: { type: String },
    photo: { type: String },
    createdAt: { type: Date, default: Date.now }
  }],
  isStory: { type: Boolean, default: false },
  expiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
}, {
  indexes: [
    { key: { isStory: 1, createdAt: -1 } }, // For GET /feed
    { key: { userId: 1 } }, // For user-specific queries
  ]
});

module.exports = mongoose.model('Post', postSchema);