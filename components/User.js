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
    // Optional because OAuth/Google users won't have a password initially
    required: function() {
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
  googleId: {
    type: String,
    default: null,
    unique: true,
    // sparse allows multiple documents to have 'null' googleId without triggering duplicate key errors
    sparse: true 
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date,
    default: Date.now
  }
});

// Changed model name to 'User' to follow standard naming conventions
const User = mongoose.model('User', userSchema);

export default User;