const mongoose = require('mongoose');
const { getCountries } = require('libphonenumber-js');
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
    sparse: true,
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
userSchema.index({ contacts: 1 });
userSchema.index({ virtualNumber: 1 }, { unique: true, sparse: true });

// Middleware for document-level deleteOne
userSchema.pre('deleteOne', { document: true, query: false }, async function (next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = this._id;
    logger.info('Deleting user and related data', { userId });

    // Delete messages in batches
    const batchSize = 1000;
    let deletedMessages = 0;
    while (true) {
      const result = await Message.deleteMany({
        $or: [{ senderId: userId }, { recipientId: userId }],
      }).limit(batchSize).session(session);
      deletedMessages += result.deletedCount;
      if (result.deletedCount < batchSize) break;
    }
    logger.info('Messages deleted for user', { userId, deletedCount: deletedMessages });

    // Remove user from other users' contact lists
    const contactResult = await mongoose.model('User').updateMany(
      { contacts: userId },
      { $pull: { contacts: userId } },
      { session }
    );
    logger.info('User removed from contacts', { userId, modifiedCount: contactResult.modifiedCount });

    await session.commitTransaction();
    next();
  } catch (error) {
    await session.abortTransaction();
    logger.error('User deletion middleware failed', { error: error.message, stack: error.stack });
    next(error);
  } finally {
    session.endSession();
  }
});

// Middleware for query-level deleteOne
userSchema.pre('deleteOne', { document: false, query: true }, async function (next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const filter = this.getFilter();
    const users = await this.model.find(filter).select('_id').session(session);
    const userIds = users.map(user => user._id);
    if (!userIds.length) {
      logger.info('No users found for deletion', { filter });
      await session.commitTransaction();
      return next();
    }

    logger.info('Deleting users and related data', { userIds });

    // Delete messages in batches
    const batchSize = 1000;
    let deletedMessages = 0;
    while (true) {
      const result = await Message.deleteMany({
        $or: [{ senderId: { $in: userIds } }, { recipientId: { $in: userIds } }],
      }).limit(batchSize).session(session);
      deletedMessages += result.deletedCount;
      if (result.deletedCount < batchSize) break;
    }
    logger.info('Messages deleted for users', { userIds, deletedCount: deletedMessages });

    // Remove users from other users' contact lists
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
    logger.error('Query deleteOne middleware failed', { error: error.message, stack: error.stack });
    next(error);
  } finally {
    session.endSession();
  }
});

// Middleware for deleteMany
userSchema.pre('deleteMany', async function (next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const filter = this.getFilter();
    const users = await this.model.find(filter).select('_id').session(session);
    const userIds = users.map(user => user._id);
    if (!userIds.length) {
      logger.info('No users found for deletion', { filter });
      await session.commitTransaction();
      return next();
    }

    logger.info('Deleting multiple users and related data', { userIds });

    // Delete messages in batches
    const batchSize = 1000;
    let deletedMessages = 0;
    while (true) {
      const result = await Message.deleteMany({
        $or: [{ senderId: { $in: userIds } }, { recipientId: { $in: userIds } }],
      }).limit(batchSize).session(session);
      deletedMessages += result.deletedCount;
      if (result.deletedCount < batchSize) break;
    }
    logger.info('Messages deleted for users', { userIds, deletedCount: deletedMessages });

    // Remove users from other users' contact lists
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
    logger.error('DeleteMany middleware failed', { error: error.message, stack: error.stack });
    next(error);
  } finally {
    session.endSession();
  }
});

// Middleware for findOneAndDelete
userSchema.pre('findOneAndDelete', async function (next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const user = await this.model.findOne(this.getFilter()).select('_id').session(session);
    if (!user) {
      logger.info('No user found for findOneAndDelete', { filter: this.getFilter() });
      await session.commitTransaction();
      return next();
    }

    const userId = user._id;
    logger.info('Deleting user and related data via findOneAndDelete', { userId });

    // Delete messages in batches
    const batchSize = 1000;
    let deletedMessages = 0;
    while (true) {
      const result = await Message.deleteMany({
        $or: [{ senderId: userId }, { recipientId: userId }],
      }).limit(batchSize).session(session);
      deletedMessages += result.deletedCount;
      if (result.deletedCount < batchSize) break;
    }
    logger.info('Messages deleted for user', { userId, deletedCount: deletedMessages });

    // Remove user from other users' contact lists
    const contactResult = await this.model.updateMany(
      { contacts: userId },
      { $pull: { contacts: userId } },
      { session }
    );
    logger.info('User removed from contacts', { userId, modifiedCount: contactResult.modifiedCount });

    await session.commitTransaction();
    next();
  } catch (error) {
    await session.abortTransaction();
    logger.error('FindOneAndDelete middleware failed', { error: error.message, stack: error.stack });
    next(error);
  } finally {
    session.endSession();
  }
});

module.exports = mongoose.model('User', userSchema);