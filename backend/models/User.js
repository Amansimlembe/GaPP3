const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true, // Implies unique index
    lowercase: true,
    trim: true,
    match: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
  },
  username: {
    type: String,
    required: true,
    unique: true, // Implies unique index
    trim: true,
    minlength: 3,
    maxlength: 20,
  },
  photo: {
    type: String,
    default: 'https://placehold.co/40x40',
  },
  country: {
    type: String,
    required: true,
    uppercase: true,
  },
  virtualNumber: {
    type: String,
    unique: true, // Implies unique index
    match: /^\+\d{10,15}$/,
    default: null,
  },
  contacts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  role: {
    type: Number,
    enum: [0, 1], // 0: Job Seeker, 1: Employer
    default: 0,
  },
  publicKey: {
    type: String,
    required: true,
  },
  privateKey: {
    type: String,
    required: true,
    select: false,
  },
  status: {
    type: Date,
    enum: ['online', 'offline'],
    default: 'offline',
  },
  lastSeen: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

// Indexes for performance (only non-unique or compound indexes)
userSchema.index({ status: 1, lastSeen: -1 }); // Optimized for ProfileScreen.js

// Pre-save hook for virtualNumber uniqueness (already handled by unique: true)
userSchema.pre('save', async function(next) {
  if (this.isModified('virtualNumber') && this.virtualNumber) {
    // Optional: Additional validation if needed, but unique: true handles it
    next();
  }
  next();
});

module.exports = mongoose.model('User', userSchema);