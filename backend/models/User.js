
const mongoose = require('mongoose');
const { getCountries, parsePhoneNumberFromString } = require('libphonenumber-js');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/user-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/user-combined.log' }),
  ],
});

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
    minlength: 8,
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
    sparse: true,
    validate: {
      validator: function (value) {
        if (!value) return true; // Allow null/undefined for sparse index
        const phoneNumber = parsePhoneNumberFromString(value, this.country);
        return phoneNumber ? phoneNumber.isValid() : false;
      },
      message: 'Invalid virtual number format for the specified country.',
    },
  },


  contacts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: [],
    validate: {
      validator: async function (value) {
        const user = await mongoose.model('User').findById(value).select('_id').lean();
        return !!user;
      },
      message: 'Invalid contact ID.',
    },
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
  },
}, {
  timestamps: true,
});

// Indexes for performance
userSchema.index({ email: 1 });
userSchema.index({ username: 1 });
userSchema.index({ virtualNumber: 1 });
userSchema.index({ contacts: 1, status: 1 });
userSchema.index({ status: 1, lastSeen: -1 });

// Pre-save hook to validate contacts
userSchema.pre('save', async function (next) {
  try {
    if (this.isModified('contacts') && this.contacts.length) {
      const uniqueContacts = [...new Set(this.contacts.map(id => id.toString()))];
      this.contacts = uniqueContacts.map(id => new mongoose.Types.ObjectId(id));
      
      const existingUsers = await this.constructor.find({ _id: { $in: this.contacts } }).select('_id').lean();
      const existingIds = new Set(existingUsers.map(user => user._id.toString()));
      const invalidContacts = uniqueContacts.filter(id => !existingIds.has(id));
      
      if (invalidContacts.length) {
        logger.error('Invalid contacts found', { invalidContacts });
        return next(new Error(`Invalid contact IDs: ${invalidContacts.join(', ')}`));
      }
    }
    next();
  } catch (error) {
    logger.error('User pre-save validation failed', { error: error.message, userId: this._id });
    next(error);
  }
});

// Static method to clean up invalid contacts
userSchema.statics.cleanupInvalidContacts = async function () {
  try {
    logger.info('Starting invalid contacts cleanup');
    const batchSize = 1000;
    let totalUpdated = 0;

    const usersWithContacts = await this.find({ contacts: { $ne: [] } }).select('_id contacts').lean();
    if (!usersWithContacts.length) {
      logger.info('No users with contacts found for cleanup');
      return { updatedCount: 0 };
    }

    for (let i = 0; i < usersWithContacts.length; i += batchSize) {
      const batch = usersWithContacts.slice(i, i + batchSize);
      const contactIds = [...new Set(batch.flatMap(user => user.contacts.map(id => id.toString())))];
      
      const existingUsers = await this.find({ _id: { $in: contactIds } }).select('_id').lean();
      const existingIds = new Set(existingUsers.map(user => user._id.toString()));

      for (const user of batch) {
        const validContacts = user.contacts.filter(id => existingIds.has(id.toString()));
        if (validContacts.length !== user.contacts.length) {
          const result = await this.updateOne(
            { _id: user._id },
            { $set: { contacts: validContacts } }
          );
          totalUpdated += result.modifiedCount || 0;
        }
      }
    }

    logger.info('Invalid contacts cleanup completed', { updatedCount: totalUpdated });
    return { updatedCount: totalUpdated };
  } catch (error) {
    logger.error('Invalid contacts cleanup failed', { error: error.message });
    throw error;
  }
};

const User = mongoose.model('User', userSchema);
module.exports = User;
