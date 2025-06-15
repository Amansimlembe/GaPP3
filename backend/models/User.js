const mongoose = require('mongoose');
const { getCountries, parsePhoneNumberFromString } = require('libphonenumber-js');
const Message = require('./Message');
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
userSchema.index({ virtualNumber: 1 }, { unique: true, sparse: true });
userSchema.index({ contacts: 1, status: 1 });
userSchema.index({ status: 1, lastSeen: -1 });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true });

// Pre-delete hook for all deletion operations
userSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], async function (next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const filter = this.getFilter();
    const users = await this.model.find(filter).select('_id').lean().session(session);
    const userIds = users.map(user => user._id.toString());
    if (!userIds.length) {
      logger.info('No users found for deletion', { filter });
      await session.commitTransaction();
      return next();
    }

    logger.info('Deleting users and related data', { userIds, operation: this.op });

    // Delete messages in batches
    const batchSize = 1000;
    const messageCount = await Message.countDocuments({
      $or: [{ senderId: { $in: userIds } }, { recipientId: { $in: userIds } }],
    }).session(session);
    for (let i = 0; i < messageCount; i += batchSize) {
      const result = await Message.deleteMany({
        $or: [{ senderId: { $in: userIds } }, { recipientId: { $in: userIds } }],
      }).limit(batchSize).session(session);
      logger.info('Messages deleted for users', { userIds, deletedCount: result.deletedCount, batch: i / batchSize });
    }

    // Remove users from contact lists
    const contactResult = await this.model.updateMany(
      { contacts: { $in: userIds } },
      { $pull: { contacts: { $in: userIds } } },
      { session }
    );
    logger.info('Users removed from contacts', { userIds, modifiedCount: contactResult.modifiedCount });

    await session.commitTransaction();
    next();
  } catch (error) {
    await session.abortTransaction();
    logger.error('User deletion failed', { error: error.message, filter, operation: this.op });
    next(error);
  } finally {
    session.endSession();
  }
});

module.exports = mongoose.model('User', userSchema);