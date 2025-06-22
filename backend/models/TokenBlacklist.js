const mongoose = require('mongoose');

const tokenBlacklistSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: '30d', // 30 days
    },
  },
  {
    timestamps: true,
  }
);

tokenBlacklistSchema.index({ token: 1 }, { unique: true });

module.exports = mongoose.model('TokenBlacklist', tokenBlacklistSchema);