const mongoose = require('mongoose');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, match: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/ },
  password: { type: String, required: true, minlength: 6 },
  username: { type: String, unique: true, required: true, minlength: 3, maxlength: 20 },
  photo: { type: String },
  country: { type: String },
  virtualNumber: { type: String, unique: true },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  role: { type: Number, default: 0 },
  publicKey: { type: String },
  privateKey: { type: String }, // Encrypted private key
  keySalt: { type: String }, // Salt for key derivation
  sharedKeys: [
    {
      contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      key: { type: String, required: true },
    },
  ],
  status: { type: String, default: 'offline', enum: ['online', 'offline'] },
  lastSeen: { type: Date },
});

// Encrypt private key before saving
userSchema.pre('save', function (next) {
  if (this.isModified('privateKey') && this.privateKey && this.password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.pbkdf2Sync(this.password, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(this.privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    this.privateKey = `${iv.toString('hex')}:${encrypted}`;
    this.keySalt = salt;
  }
  next();
});

// Method to decrypt private key
userSchema.methods.decryptPrivateKey = function (password) {
  if (!this.privateKey || !this.keySalt) throw new Error('Private key or salt missing');
  const [ivHex, encrypted] = this.privateKey.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = crypto.pbkdf2Sync(password, this.keySalt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

// Indexes
userSchema.index({ virtualNumber: 1 });
userSchema.index({ 'sharedKeys.contactId': 1 });

module.exports = mongoose.model('User', userSchema);