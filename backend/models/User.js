const mongoose = require('mongoose');

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
  privateKey: { type: String, required: true },
  status: { type: String, default: 'offline', enum: ['online', 'offline'] },
  lastSeen: { type: Date },
});

userSchema.index({ virtualNumber: 1 });

module.exports = mongoose.model('User', userSchema);