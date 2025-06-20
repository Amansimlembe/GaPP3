const mongoose = require('mongoose');
const { getCountries, parsePhoneNumberFromString, isValidPhoneNumber } = require('libphonenumber-js');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
    winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/user-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/user-info.log' }),
  ],
});

// Retry utility for MongoDB operations
const withRetry = async (operation, maxRetries = 3, delay = 1000) => {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error.code === 11000) {
        throw error; // No retry for duplicate key errors
      }
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delay * attempt));
        logger.warn('Retrying MongoDB operation', { attempt, error: error.message });
      }
    }
  }
  throw lastError;
};

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
    required: true,
    unique: true,
    validate: {
      validator: function (value) {
        const phoneNumber = parsePhoneNumberFromString(value, this.country);
        return phoneNumber && isValidPhoneNumber(value, this.country);
      },
      message: 'Invalid virtual number format for the specified country.',
    },
  },
  contacts: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: [],
    validate: {
      validator: async function (values) {
        if (!values.length) return true;
        try {
          const uniqueIds = [...new Set(values.map((id) => id.toString()))];
          const users = await withRetry(() =>
            mongoose.model('User').find({ _id: { $in: uniqueIds } }).select('_id').lean()
          );
          const validIds = new Set(users.map((user) => user._id.toString()));
          return uniqueIds.every((id) => validIds.has(id));
        } catch (error) {
          logger.error('Contacts validation failed', {
            error: error.message,
            userId: this._id?.toString(),
            contacts: values.map(String),
          });
          return false;
        }
      },
      message: 'One or more invalid contact IDs.',
    },
  },
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
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ virtualNumber: 1 }, { unique: true });
userSchema.index({ virtualNumber: 1, country: 1 });
userSchema.index({ contacts: 1, status: 1 });
userSchema.index({ status: 1, lastSeen: -1 });

// Pre-save hook to validate and clean contacts
userSchema.pre('save', async function (next) {
  try {
    if (this.isModified('contacts') && this.contacts.length) {
      // Remove duplicates
      const uniqueIds = [...new Set(this.contacts.map((id) => id.toString()))];
      this.contacts = uniqueIds.map((id) => new mongoose.Types.ObjectId(id));

      // Validate contacts
      const existingUsers = await withRetry(() =>
        this.constructor.find({ _id: { $in: this.contacts } }).select('_id').lean()
      );
      const existingIds = new Set(existingUsers.map((user) => user._id.toString()));
      const invalidContacts = uniqueIds.filter((id) => !existingIds.has(id));

      if (invalidContacts.length) {
        logger.error('Invalid contacts found during save', {
          userId: this._id?.toString(),
          invalidContacts,
          email: this.email,
        });
        return next(new Error(`Invalid contact IDs: ${invalidContacts.join(', ')}`));
      }
    }
    next();
  } catch (error) {
    logger.error('User pre-save validation failed', {
      error: error.message,
      stack: error.stack,
      userId: this._id?.toString(),
      email: this.email,
    });
    next(error);
  }
});

// Static method to clean up invalid contacts
userSchema.statics.cleanupInvalidContacts = async function () {
  try {
    logger.info('Starting invalid contacts cleanup');
    const batchSize = 1000;
    let totalUpdated = 0;
    let removedIds = [];

    const usersWithContacts = await withRetry(() =>
      this.find({ contacts: { $ne: [] } }).select('_id contacts email').lean()
    );
    if (!usersWithContacts.length) {
      logger.info('No users with contacts found for cleanup');
      return { updatedCount: 0, removedIds: [] };
    }

    for (let i = 0; i < usersWithContacts.length; i += batchSize) {
      const batch = usersWithContacts.slice(i, i + batchSize);
      const contactIds = [...new Set(batch.flatMap((user) => user.contacts.map((id) => id.toString())))];
      
      const existingUsers = await withRetry(() =>
        this.find({ _id: { $in: contactIds } }).select('_id').lean()
      );
      const existingIds = new Set(existingUsers.map((user) => user._id.toString()));

      for (const user of batch) {
        const invalidContacts = user.contacts.filter((id) => !existingIds.has(id.toString()));
        if (invalidContacts.length) {
          const validContacts = user.contacts.filter((id) => existingIds.has(id.toString()));
          const result = await withRetry(() =>
            this.updateOne(
              { _id: user._id },
              { $set: { contacts: validContacts } }
            )
          );
          totalUpdated += result.modifiedCount || 0;
          removedIds.push(...invalidContacts.map(String));
          logger.info('Removed invalid contacts', {
            userId: user._id.toString(),
            email: user.email,
            removedContacts: invalidContacts,
          });
        }
      }
    }

    logger.info('Invalid contacts cleanup completed', { updatedCount: totalUpdated, removedIdsCount: removedIds.length });
    return { updatedCount: totalUpdated, removedIds };
  } catch (error) {
    logger.error('Invalid contacts cleanup failed', { error: error.message, stack: error.stack });
    throw error;
  }
};

// Periodic cleanup on startup
const scheduleCleanup = async () => {
  try {
    const result = await User.cleanupInvalidContacts();
    logger.info('Initial contacts cleanup on startup', result);
    // Schedule periodic cleanup (e.g., every 24 hours)
    setInterval(async () => {
      try {
        const periodicResult = await User.cleanupInvalidContacts();
        logger.info('Periodic contacts cleanup', periodicResult);
      } catch (error) {
        logger.error('Periodic cleanup failed', { error: error.message });
      }
    }, 24 * 60 * 60 * 1000);
  } catch (error) {
    logger.error('Initial cleanup on startup failed', { error: error.message });
  }
};
scheduleCleanup();

const User = mongoose.model('User', userSchema);
module.exports = User;