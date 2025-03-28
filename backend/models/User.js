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
  publicKey: { type: String }, // ECDH public key
  privateKey: { type: String }, // ECDH private key (stored securely)
  sharedKeys: [
    {
      contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      key: { type: String, required: true },
    },
  ], // Shared keys for each contact
  status: { type: String, default: 'offline' },
  lastSeen: { type: Date },
});

// Add indexes for faster lookups
userSchema.index({ virtualNumber: 1 }); // For quick contact lookup by virtualNumber
userSchema.index({ 'sharedKeys.contactId': 1 }); // For fast shared key retrieval

module.exports = mongoose.model('User', userSchema);