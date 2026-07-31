import mongoose from 'mongoose';

const officialUserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  },
  password: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: ['super_admin', 'admin', 'manager'],
    default: 'manager',
    index: true,
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'blocked', 'rejected'],
    default: 'pending',
    index: true,
  },
  permissions: {
    type: [String],
    default: [],
  },
  sourceUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  note: {
    type: String,
    trim: true,
    default: '',
  },
  rejectionReason: {
    type: String,
    trim: true,
    default: '',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OfficialUser',
    default: null,
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OfficialUser',
    default: null,
  },
  reviewedAt: {
    type: Date,
    default: null,
  },
  lastLogin: {
    type: Date,
    default: null,
  },
  passwordResetOtpHash: {
    type: String,
    default: '',
  },
  passwordResetOtpExpiresAt: {
    type: Date,
    default: null,
  },
  passwordResetOtpRequestedAt: {
    type: Date,
    default: null,
  },
  passwordResetOtpAttempts: {
    type: Number,
    default: 0,
  },
}, { timestamps: true });

officialUserSchema.index({ email: 1 }, { unique: true });

const OfficialUser = mongoose.model('OfficialUser', officialUserSchema, 'official_users');

export default OfficialUser;

