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
  entryVideoUrl: {
    type: String,
    default: ''
  },
  frameUrl: {
    type: String,
    default: ''
  },
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