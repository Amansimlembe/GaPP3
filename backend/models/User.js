// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  country: { type: String, required: true },
  virtualNumber: { type: String, unique: true },
  publicKey: { type: String },
  privateKey: { type: String },
  photo: { type: String, default: 'https://placehold.co/40x40' },
  role: { type: Number, default: 0 },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  sharedKeys: [{ contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, key: String }],
  status: { type: String, default: 'offline' },
  lastSeen: { type: Date },
});

module.exports = mongoose.model('User', userSchema);