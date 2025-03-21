const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: Number, default: 0 }, // 0: Job Seeker, 1: Employer
  cv: String,
  photo: String,
  coverLetter: String,
  skills: [String],
});

module.exports = mongoose.model('User', userSchema);