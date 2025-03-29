// user.js
const mongoose = require('mongoose');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, match: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/ },
  password: { type: String, required: true, minlength: 6 },
  username: { type: String, unique: true, required: true, minlength: 3, maxlength: 20 },
  photo: { type: String, default: 'https://placehold.co/40x40' },
  country: { type: String, required: true },
  virtualNumber: { type: String, unique: true, required: true },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  role: { type: Number, default: 0 },
  publicKey: { type: String, required: true },
  privateKey: { type: String, required: true }, // Stored as PEM, not encrypted
  sharedKeys: [
    {
      contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      key: { type: String, required: true },
    },
  ],
  status: { type: String, default: 'offline', enum: ['online', 'offline'] },
  lastSeen: { type: Date },
});

// Remove pre-save hook for encryption since privateKey is stored as PEM
// Indexes
userSchema.index({ virtualNumber: 1 });
userSchema.index({ 'sharedKeys.contactId': 1 });

module.exports = mongoose.model('User', userSchema);