const mongoose = require('mongoose');
const { getCountries } = require('libphonenumber-js');
const Message = require('./Message'); // Import Message model

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
    validate: {
      validator: function (value) {
        const validCountries = getCountries();
        return validCountries.includes(value.toUpperCase());
      },
      message: 'Invalid country code. Must be a valid ISO 3166-1 alpha-2 code.',
    },
  },
  virtualNumber: {
    type: String,
    unique: true,
    match: /^\+\d{1,4}[1-9]{5}\d{4}$/,
    default: null,
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
userSchema.index({ status: 1, lastSeen: -1 });

// Middleware for document-level deleteOne
userSchema.pre('deleteOne', { document: true, query: false }, async function (next) {
  try {
    const userId = this._id;
    await Message.deleteMany({
      $or: [
        { senderId: userId },
        { recipientId: userId },
      ],
    });
    next();
  } catch (error) {
    next(error);
  }
});

// Middleware for query-level deleteOne and deleteMany
userSchema.pre('deleteOne', { document: false, query: true }, async function (next) {
  try {
    const filter = this.getFilter();
    const users = await this.model.find(filter).select('_id');
    const userIds = users.map(user => user._id);
    if (userIds.length > 0) {
      await Message.deleteMany({
        $or: [
          { senderId: { $in: userIds } },
          { recipientId: { $in: userIds } },
        ],
      });
    }
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.pre('deleteMany', async function (next) {
  try {
    const filter = this.getFilter();
    const users = await this.model.find(filter).select('_id');
    const userIds = users.map(user => user._id);
    if (userIds.length > 0) {
      await Message.deleteMany({
        $or: [
          { senderId: { $in: userIds } },
          { recipientId: { $in: userIds } },
        ],
      });
    }
    next();
  } catch (error) {
    next(error);
  }
});

// Middleware for findOneAndDelete
userSchema.pre('findOneAndDelete', async function (next) {
  try {
    const user = await this.model.findOne(this.getFilter()).select('_id');
    if (user) {
      await Message.deleteMany({
        $or: [
          { senderId: user._id },
          { recipientId: user._id },
        ],
      });
    }
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('User', userSchema);