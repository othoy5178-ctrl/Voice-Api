import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: function () {
      return !this.googleId;
    }
  },
  profilePic: {
    type: String,
    default: '' // Points to a CDN URL or remains empty string until uploaded
  },
  gender: {
    type: String,
    enum: ['Male', 'Female', 'Other', ''],
    default: ''
  },
  age: {
    type: Number,
    min: 1,
    max: 120,
    default: null
  },
  birthday: {
    type: String,
    trim: true,
    default: ''
  },
  countryRegion: {
    type: String,
    trim: true,
    default: ''
  },
  voiceSignature: {
    type: String,
    trim: true,
    maxlength: 120,
    default: ''
  },
  signature: {
    type: String,
    trim: true,
    maxlength: 160,
    default: ''
  },
  albumPhotos: {
    type: [String],
    default: []
  },
  glixId: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  entryVideoUrl: {
    type: String,
    default: ''
  },
  frameUrl: {
    type: String,
    default: ''
  },
  fcmTokens: [{
    token: { type: String, required: true },
    platform: { type: String, enum: ['android', 'ios', 'web', 'unknown'], default: 'unknown' },
    updatedAt: { type: Date, default: Date.now }
  }],
  settings: {
    floatingPlayer: { type: Boolean, default: true },
    newMessageNotifications: { type: Boolean, default: true },
    liveNotifications: { type: Boolean, default: true },
    giftNotifications: { type: Boolean, default: true },
    showOnlineStatus: { type: Boolean, default: true },
    allowMessagesFrom: {
      type: String,
      enum: ['everyone', 'following', 'none'],
      default: 'everyone'
    },
    allowRoomInvites: { type: Boolean, default: true },
    showProfileVisits: { type: Boolean, default: true },
    language: { type: String, default: 'English' }
  },
  blacklistedUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  googleId: {
    type: String,
    default: null,
    unique: true,
    sparse: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  accountStatus: {
    type: String,
    enum: ['active', 'suspended', 'banned'],
    default: 'active',
    index: true
  },
  adminNote: {
    type: String,
    trim: true,
    default: ''
  },
  passwordResetOtpHash: {
    type: String,
    default: ''
  },
  passwordResetOtpExpiresAt: {
    type: Date,
    default: null
  },
  passwordResetOtpRequestedAt: {
    type: Date,
    default: null
  },
  passwordResetOtpAttempts: {
    type: Number,
    default: 0
  },
  followersCount: { type: Number, default: 0 },
  followingCount: { type: Number, default: 0 },
  daimon: { type: Number, default: 0 },
  chang: { type: Number, default: 0 },
  role: {
    type: String,
    enum: ['user', 'host', 'agency', 'manager', 'admin', 'coin_seller'],
    default: 'user',
    index: true
  },
  agencyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  agencyCode: {
    type: String,
    trim: true,
    uppercase: true,
    sparse: true,
    index: true
  },
  managerPermissions: {
    type: [String],
    default: []
  },
  adminAccessRequest: {
    requestedRole: {
      type: String,
      enum: ['manager', 'admin', ''],
      default: ''
    },
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none',
      index: true
    },
    note: { type: String, trim: true, default: '' },
    rejectionReason: { type: String, trim: true, default: '' },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    reviewedAt: { type: Date, default: null },
    requestedAt: { type: Date, default: null }
  },
  commissionBalance: { type: Number, default: 0 },
  revenueBalance: { type: Number, default: 0 },
  totalHostCoins: { type: Number, default: 0 },
  sellerBalance: { type: Number, default: 0 },
  sellerTotalSold: { type: Number, default: 0 },
  coinSellerStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected', 'suspended'],
    default: 'none',
    index: true
  },
  coinSellerRejectionReason: { type: String, trim: true, default: '' },
  coinSellerRegistration: {
    fullName: { type: String, trim: true, default: '' },
    phoneNumber: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    paymentMethod: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected', 'suspended'],
      default: 'none'
    },
    rejectionReason: { type: String, trim: true, default: '' },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    reviewedAt: { type: Date, default: null },
    registeredAt: { type: Date, default: null }
  },
  hostStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected'],
    default: 'none',
    index: true
  },
  hostRejectionReason: { type: String, trim: true, default: '' },
  hostRegistration: {
    fullName: { type: String, trim: true, default: '' },
    gender: {
      type: String,
      enum: ['Male', 'Female', 'Other', ''],
      default: ''
    },
    hostType: {
      type: String,
      enum: ['Video Live Host', 'Voice Live Host', ''],
      default: ''
    },
    agencySelection: {
      type: String,
      enum: ['Official', 'Other Agency', ''],
      default: ''
    },
    agencyCode: { type: String, trim: true, uppercase: true, default: '' },
    phoneCountryCode: { type: String, trim: true, default: '' },
    phoneNumber: { type: String, trim: true, default: '' },
    profilePhotoUrl: { type: String, default: '' },
    idFrontUrl: { type: String, default: '' },
    idBackUrl: { type: String, default: '' },
    selfiePhotoUrl: { type: String, default: '' },
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none'
    },
    rejectionReason: { type: String, trim: true, default: '' },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    reviewedAt: { type: Date, default: null },
    acceptedTerms: { type: Boolean, default: false },
    registeredAt: { type: Date, default: null }
  },
  agencyStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected'],
    default: 'none',
    index: true
  },
  agencyRejectionReason: { type: String, trim: true, default: '' },
  agencyRegistration: {
    agencyName: { type: String, trim: true, default: '' },
    ownerName: { type: String, trim: true, default: '' },
    requestedAgencyCode: { type: String, trim: true, uppercase: true, default: '' },
    phoneCountryCode: { type: String, trim: true, default: '' },
    phoneNumber: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    expectedHosts: { type: Number, default: 0 },
    experience: { type: String, trim: true, default: '' },
    profilePhotoUrl: { type: String, default: '' },
    idFrontUrl: { type: String, default: '' },
    idBackUrl: { type: String, default: '' },
    selfiePhotoUrl: { type: String, default: '' },
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none'
    },
    rejectionReason: { type: String, trim: true, default: '' },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    reviewedAt: { type: Date, default: null },
    acceptedTerms: { type: Boolean, default: false },
    registeredAt: { type: Date, default: null }
  },
});

// Changed model name to 'User' to follow standard naming conventions
const User = mongoose.model('User', userSchema);

export default User;


