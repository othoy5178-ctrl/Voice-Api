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
  followersCount: { type: Number, default: 0 },
  followingCount: { type: Number, default: 0 },
  daimon: { type: Number, default: 0 },
  chang: { type: Number, default: 0 },
});

// Changed model name to 'User' to follow standard naming conventions
const User = mongoose.model('User', userSchema);

export default User;
