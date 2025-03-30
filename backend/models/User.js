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
    default: 'https://placehold.co/40x40',
  },
  country: {
    type: String,
    required: true,
    uppercase: true,
  },
  virtualNumber: {
    type: String,
    required: true,
    unique: true,
    match: /^\+\d{10,15}$/,
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
    select: false, // Exclude from default queries for security
  },
  status: {
    type: String,
    enum: ['online', 'offline'],
    default: 'offline',
  },
  lastSeen: {
    type: Date,
  },
}, {
  timestamps: true, // Adds createdAt and updatedAt fields
});

// Indexes for performance
userSchema.index({ virtualNumber: 1 });
userSchema.index({ username: 1 });
userSchema.index({ email: 1 });
userSchema.index({ status: 1, lastSeen: -1 });

// Pre-save hook to ensure uniqueness of virtualNumber
userSchema.pre('save', async function (next) {
  const user = this;
  if (user.isModified('virtualNumber')) {
    const existingUser = await mongoose.model('User').findOne({ virtualNumber: user.virtualNumber });
    if (existingUser && existingUser._id.toString() !== user._id.toString()) {
      return next(new Error('Virtual number already in use'));
    }
  }
  next();
});

module.exports = mongoose.model('User', userSchema);