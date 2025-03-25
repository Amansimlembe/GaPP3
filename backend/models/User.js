 const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  username: { type: String, unique: true },
  photo: { type: String },
  country: { type: String },
  virtualNumber: { type: String, unique: true },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  role: { type: Number, default: 0 },
  publicKey: { type: String },
});

module.exports = mongoose.model('User', userSchema);