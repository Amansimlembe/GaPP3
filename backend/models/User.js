const mongoose = require('mongoose');
const validator = require('validator');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Please provide an email'],
      unique: true,
      lowercase: true,
      trim: true,
      validate: [validator.isEmail, 'Please provide a valid email'],
    },
    username: {
      type: String,
      required: [true, 'Please provide a username'],
      unique: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username cannot exceed 30 characters'],
    },
    virtualNumber: {
      type: String,
      required: [true, 'Please provide a virtual number'],
      unique: true,
      trim: true,
      validate: {
        validator: function (v) {
          return /^\+\d{7,15}$/.test(v);
        },
        message: 'Virtual number must be in the format +1234567890 (7-15 digits)',
      },
    },
    password: {
      type: String,
      required: [true, 'Please provide a password'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    publicKey: {
      type: String,
      required: [true, 'Public key is required'],
    },
    privateKey: {
      type: String,
      required: [true, 'Private key is required'],
      select: false,
    },
    photo: {
      type: String,
      default: 'https://placehold.co/40x40',
      validate: {
        validator: function (v) {
          return validator.isURL(v);
        },
        message: 'Photo must be a valid URL',
      },
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
    contacts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    role: {
      type: String,
      enum: ['jobseeker', 'employer'],
      default: 'jobseeker',
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Define indexes explicitly
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ virtualNumber: 1 }, { unique: true });

// Pre-save hook to ensure contacts are valid ObjectIds
userSchema.pre('save', function (next) {
  if (this.isModified('contacts') && this.contacts) {
    this.contacts = this.contacts.filter((id) => mongoose.isValidObjectId(id));
  }
  next();
});

module.exports = mongoose.model('User', userSchema);