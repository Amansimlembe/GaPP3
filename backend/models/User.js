
const mongoose = require('mongoose');
const { getCountries, parsePhoneNumberFromString } = require('libphonenumber-js');
const winston = require('winston');

// Logger configuration with deduplication
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
    winston.format((info) => {
      const errorKey = `${info.error}:${info.userId || 'unknown'}`;
      info.errorCount = logger.errorCounts.get(errorKey) || 0;
      if (info.level === 'error' && info.errorCount >= 2) return false;
      logger.errorCounts.set(errorKey, info.errorCount + 1);
      setTimeout(() => logger.errorCounts.delete(errorKey), 60 * 1000);
      return info;
    })()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/user-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/user-combined.log' }),
  ],
  errorCounts: new Map(),
});

// Retry with exponential backoff
const retryOperation = async (operation, maxRetries = 3, baseDelay = 2000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      logger.warn('Retrying MongoDB operation', { attempt, error: err.message, stack: err.stack });
      if (attempt === maxRetries) {
        logger.error('MongoDB operation failed after retries', { error: err.message, stack: err.stack });
        throw err;
      }
      const delay = Math.pow(2, attempt) * baseDelay; // Exponential backoff: 2s, 4s, 8s
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Invalid email format'],
      index: true, // Explicit index
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
      maxlength: [50, 'Username cannot exceed 50 characters'], // Increased to align with social.js
      index: true, // Explicit index
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
      default: null,
      validate: {
        validator: function (value) {
          if (!value) return true;
          const phoneNumber = parsePhoneNumberFromString(value, this.country);
          return phoneNumber ? phoneNumber.isValid() : false;
        },
        message: 'Invalid virtual number format for the specified country.',
      },
      index: true, // Explicit index
    },
    contacts: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      validate: {
        validator: function (value) {
          return value.length <= 500; // Reduced to 500 for performance
        },
        message: 'Contacts list cannot exceed 500 entries.',
      },
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
      default: null,
    },
  },
  {
    timestamps: true, // Keep enabled for createdAt/updatedAt
  }
);

// Optimized indexes with names
userSchema.index({ email: 1 }, { unique: true, name: 'email_unique_idx' });
userSchema.index({ username: 1 }, { unique: true, name: 'username_unique_idx' });
userSchema.index({ virtualNumber: 1 }, { unique: true, sparse: true, name: 'virtual_number_unique_idx' });
userSchema.index({ contacts: 1, name: 'contacts_idx' });
userSchema.index({ status: 1, lastSeen: 1 }, { name: 'status_lastSeen_idx' });

// Pre-save hook with optimized contact validation
userSchema.pre('save', async function (next) {
  try {
    await retryOperation(async () => {
      if (this.isModified('contacts') && this.contacts.length) {
        const uniqueContacts = [...new Set(this.contacts.map((id) => id.toString()))].filter(
          (id) => mongoose.isValidObjectId(id) && id !== this._id.toString() // Prevent self-reference
        );
        if (uniqueContacts.length > 500) {
          throw new Error('Contacts list cannot exceed 500 entries.');
        }
        const existingContacts = await this.constructor
          .find({ _id: { $in: uniqueContacts } })
          .select('_id')
          .lean();
        const validContacts = existingContacts.map((contact) => contact._id.toString());
        this.contacts = uniqueContacts
          .filter((id) => validContacts.includes(id))
          .map((id) => new mongoose.Types.ObjectId(id));
      }
      if (this.isModified('virtualNumber') && this.virtualNumber) {
        const phoneNumber = parsePhoneNumberFromString(this.virtualNumber, this.country);
        if (!phoneNumber || !phoneNumber.isValid()) {
          throw new Error('Invalid virtual number format for the specified country.');
        }
      }
    });
    logger.info('User pre-save validation completed', { userId: this._id?.toString() });
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
    const batchSize = 500; // Reduced for faster processing
    let totalUpdated = 0;

    const userStream = this.find({ contacts: { $ne: [] } })
      .select('_id contacts')
      .lean()
      .cursor();

    const existingUserIds = new Set(
      (await this.find({}).select('_id').lean()).map((user) => user._id.toString())
    );

    const updates = [];
    for await (const user of userStream) {
      const validContacts = user.contacts
        .filter((id) => existingUserIds.has(id.toString()) && id.toString() !== user._id.toString())
        .map((id) => new mongoose.Types.ObjectId(id));
      if (validContacts.length !== user.contacts.length) {
        updates.push({
          updateOne: {
            filter: { _id: user._id },
            update: {
              $set: {
                contacts: [...new Set(validContacts.map((id) => id.toString()))].map(
                  (id) => new mongoose.Types.ObjectId(id)
                ),
              },
            },
          },
        });
      }
      if (updates.length >= batchSize) {
        await retryOperation(async () => {
          const result = await this.bulkWrite(updates, { ordered: false });
          totalUpdated += result.modifiedCount || 0;
          logger.debug('Invalid contacts cleanup batch', {
            updated: result.modifiedCount,
            batchSize,
          });
        });
        updates.length = 0;
      }
    }

    if (updates.length) {
      await retryOperation(async () => {
        const result = await this.bulkWrite(updates, { ordered: false });
        totalUpdated += result.modifiedCount || 0;
        logger.debug('Invalid contacts cleanup final batch', {
          updated: result.modifiedCount,
          batchSize: updates.length,
        });
      });
    }

    logger.info('Invalid contacts cleanup completed', { updatedCount: totalUpdated });
    return { updatedCount: totalUpdated };
  } catch (error) {
    logger.error('Invalid contacts cleanup failed', {
      error: error.message,
      stack: error.stack,
    });
    throw new Error(`Cleanup failed: ${error.message}`);
  }
};

// Static method to reset stale online statuses
userSchema.statics.resetStaleStatuses = async function (thresholdMinutes = 15) {
  try {
    logger.info('Starting stale status cleanup');
    const threshold = new Date(Date.now() - thresholdMinutes * 60 * 1000);
    const result = await retryOperation(async () => {
      return await this.updateMany(
        { status: 'online', lastSeen: { $lt: threshold } },
        { $set: { status: 'offline', lastSeen: new Date() } }
      );
    });
    logger.info('Stale status cleanup completed', { updatedCount: result.modifiedCount });
    return { updatedCount: result.modifiedCount };
  } catch (error) {
    logger.error('Stale status cleanup failed', {
      error: error.message,
      stack: error.stack,
    });
    throw new Error(`Stale status cleanup failed: ${error.message}`);
  }
};

// Periodic cleanup for stale statuses every 10 minutes
setInterval(() => {
  User.resetStaleStatuses().catch((err) => {
    logger.error('Periodic stale status cleanup failed', { error: err.message });
  });
}, 10 * 60 * 1000);

// Initial cleanup on startup
User.cleanupInvalidContacts().catch((err) => {
  logger.error('Initial invalid contacts cleanup failed', { error: err.message });
});
User.resetStaleStatuses().catch((err) => {
  logger.error('Initial stale status cleanup failed', { error: err.message });
});

const User = mongoose.model('User', userSchema);
module.exports = User;