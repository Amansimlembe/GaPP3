const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
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
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 20,
  },
  photo: {
    type: String,
    default: 'https://placehold.co/40x40', // Matches auth.js default
  },
  country: {
    type: String,
    required: true,
    uppercase: true,
  },
  virtualNumber: {
    type: String,
    unique: true,
    match: /^\+\d{10,15}$/,
    default: null, // Allow null initially, set in auth.js
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
    type: String,
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

// Indexes for performance
userSchema.index({ virtualNumber: 1 }, { sparse: true });
userSchema.index({ username: 1 });
userSchema.index({ email: 1 });
userSchema.index({ status: 1, lastSeen: -1, _id: 1 }); // Optimized for ProfileScreen.js

// Pre-save hook for virtualNumber uniqueness
userSchema.pre('save', async function (next) {
  if (this.isModified('virtualNumber') && this.virtualNumber) {
    const existingUser = await this.constructor.findOne({ virtualNumber: this.virtualNumber });
    if (existingUser && existingUser._id.toString() !== this._id.toString()) {
      return next(new Error('Virtual number already in use'));
    }
  }
  next();
});

module.exports = mongoose.model('User', userSchema);