const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  role: { type: Number, required: true }, // 0: Job Seeker, 1: Employer
  cv: String, // File path
  skills: [String],
  profilePic: { type: String, default: '/uploads/default_profile.jpg' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);