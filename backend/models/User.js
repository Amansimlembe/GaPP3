const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, maxlength: 255 },
  password: { type: String, required: true, maxlength: 255 },
  username: { type: String, required: true, unique: true, minlength: 3, maxlength: 20 },
  role: { type: Number, required: true, enum: [0, 1] },
  country: { type: String, required: true, length: 2 },
  virtualNumber: { type: String, unique: true },
  photo: { type: String, default: 'https://placehold.co/40x40' },
  publicKey: { type: String, required: true },
  privateKey: { type: String, required: true },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, default: 'offline' },
  lastSeen: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);