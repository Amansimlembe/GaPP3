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

// Changed: Retry with exponential backoff
const retryOperation = async (operation, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn('Retrying operation', { attempt, error: err.message });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

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
    default: null,
    validate: {
      validator: function (value) {
        if (!value) return true;
        const phoneNumber = parsePhoneNumberFromString(value, this.country);
        return phoneNumber ? phoneNumber.isValid() : false;
      },
      message: 'Invalid virtual number format for the specified country.',
    },
  },
  contacts: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: [],
    // Changed: Add max length for contacts
    validate: {
      validator: function (value) {
        return value.length <= 1000; // Max 1000 contacts
      },
      message: 'Contacts list cannot exceed 1000 entries.',
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
  },
}, {
  timestamps: true,
});

// Changed: Optimized indexes
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ virtualNumber: 1 }, { unique: true, sparse: true });
userSchema.index({ contacts: 1 });
userSchema.index({ status: 1, lastSeen: 1 }); // Changed: Support status cleanup

// Pre-save hook
userSchema.pre('save', async function (next) {
  try {
    await retryOperation(async () => {
      if (this.isModified('contacts') && this.contacts.length) {
        // Changed: Use Set for deduplication and bulk validation
        const uniqueContacts = [...new Set(this.contacts.map((id) => id.toString()))].filter(
          (id) => mongoose.isValidObjectId(id)
        );
        if (uniqueContacts.length > 1000) {
          throw new Error('Contacts list cannot exceed 1000 entries.');
        }
        const existingContacts = await this.constructor.find(
          { _id: { $in: uniqueContacts } },
          '_id'
        ).lean();
        const validContacts = existingContacts.map((contact) => contact._id);
        this.contacts = validContacts;
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
    const batchSize = 1000;
    let totalUpdated = 0;

    // Changed: Stream users to reduce memory usage
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
      // Changed: Process batches incrementally
      if (updates.length >= batchSize) {
        await retryOperation(async () => {
          const result = await this.bulkWrite(updates);
          totalUpdated += result.modifiedCount || 0;
          logger.debug('Invalid contacts cleanup batch', { updated: result.modifiedCount, batchSize });
        });
        updates.length = 0; // Clear array
      }
    }

    // Process remaining updates
    if (updates.length) {
      await retryOperation(async () => {
        const result = await this.bulkWrite(updates);
        totalUpdated += result.modifiedCount || 0;
        logger.debug('Invalid contacts cleanup final batch', { updated: result.modifiedCount, batchSize: updates.length });
      });
    }

    logger.info('Invalid contacts cleanup completed', { updatedCount: totalUpdated });
    return { updatedCount: totalUpdated };
  } catch (error) {
    logger.error('Invalid contacts cleanup failed', { error: error.message, stack: error.stack });
    throw new Error(`Cleanup failed: ${error.message}`);
  }
};

// Static method to reset stale online statuses
userSchema.statics.resetStaleStatuses = async function (thresholdMinutes = 30) {
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
    logger.error('Stale status cleanup failed', { error: error.message, stack: error.stack });
    throw new Error(`Stale status cleanup failed: ${error.message}`);
  }
};

const User = mongoose.model('User', userSchema);
module.exports = User;