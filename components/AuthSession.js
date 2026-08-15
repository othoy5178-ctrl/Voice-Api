import mongoose from 'mongoose';

const authSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  officialUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OfficialUser',
    default: null,
    index: true
  },
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  lastUsedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
authSessionSchema.index({ userId: 1, tokenHash: 1, expiresAt: 1 });

authSessionSchema.pre('validate', function requireSessionOwner(next) {
  if (!this.userId && !this.officialUserId) {
    next(new Error('Auth session requires a userId or officialUserId'));
    return;
  }
  next();
});

const AuthSession = mongoose.model('AuthSession', authSessionSchema);

export default AuthSession;
