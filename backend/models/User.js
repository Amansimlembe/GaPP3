const mongoose = require('mongoose'); // Import mongoose

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  username: { type: String, unique: true },
  photo: { type: String },
  country: { type: String },
  virtualNumber: { type: String, unique: true },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  role: { type: Number, default: 0 },
  publicKey: { type: String }, // Added for E2EE
  status: { type: String, default: 'offline' }, // Added for online status
  lastSeen: { type: Date }, // Added for online status
});

// Export the model
module.exports = mongoose.model('User', userSchema);
