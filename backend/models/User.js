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
    match: [/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Invalid email format'],
  },
  password: {
    type: String,
    required: true,
    minlength: [8, 'Password must be at least 8 characters'],
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [20, 'Username cannot exceed 20 characters'],
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
        if (!value) return true; // Allow null/undefined
        const phoneNumber = parsePhoneNumberFromString(value, this.country);
        return phoneNumber ? phoneNumber.isValid() : false;
      },
      message: 'Invalid virtual number format for the specified country.',
    },
  },
  contacts: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: [],
  },
  role: {
    type: Number,
    enum: { values: [0, 1], message: 'Role must be 0 (Job Seeker) or 1 (Employer)' },
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
    enum: { values: ['online', 'offline'], message: 'Status must be online or offline' },
    default: 'offline',
  },
  lastSeen: {
    type: Date,
  },
}, {
  timestamps: true,
});

// Indexes
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ virtualNumber: 1 }, { unique: true, sparse: true });

// Pre-save hook
userSchema.pre('save', async function (next) {
  try {
    if (this.isModified('contacts') && this.contacts.length) {
      // Remove duplicates and validate ObjectIds
      const uniqueContacts = [...new Set(this.contacts.map((id) => id.toString()))];
      const validContacts = [];
      for (const id of uniqueContacts) {
        if (!mongoose.isValidObjectId(id)) {
          logger.warn('Invalid contact ID', { userId: this._id?.toString(), contactId: id });
          continue;
        }
        const contact = await this.constructor.findById(id).select('_id').lean();
        if (contact) {
          validContacts.push(new mongoose.Types.ObjectId(id));
        } else {
          logger.warn('Contact does not exist', { userId: this._id?.toString(), contactId: id });
        }
      }
      this.contacts = validContacts;
    }
    next();
  } catch (error) {
    logger.error('User pre-save failed', {
      error: error.message,
      stack: error.stack,
      userId: this._id?.toString(),
    });
    next(new Error(`User validation failed: ${error.message}`));
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

    const existingUserIds = new Set(
      (await this.find({}).select('_id').lean()).map((user) => user._id.toString())
    );

    const updates = [];
    for (const user of usersWithContacts) {
      const validContacts = user.contacts
        .filter((id) => existingUserIds.has(id.toString()))
        .map((id) => new mongoose.Types.ObjectId(id));
      if (validContacts.length !== user.contacts.length) {
        updates.push({
          updateOne: {
            filter: { _id: user._id },
            update: { $set: { contacts: [...new Set(validContacts.map((id) => id.toString()))].map(
              (id) => new mongoose.Types.ObjectId(id)
            ) } },
          },
        });
      }
    }

    if (updates.length) {
      const result = await this.bulkWrite(updates);
      totalUpdated = result.modifiedCount || 0;
      logger.info('Invalid contacts cleanup batch completed', { updatedCount: totalUpdated, batchSize: updates.length });
    }

    logger.info('Invalid contacts cleanup completed', { updatedCount: totalUpdated });
    return { updatedCount: totalUpdated };
  } catch (error) {
    logger.error('Invalid contacts cleanup failed', { error: error.message, stack: error.stack });
    throw new Error(`Cleanup failed: ${error.message}`);
  }
};

const User = mongoose.model('User', userSchema);
module.exports = User;