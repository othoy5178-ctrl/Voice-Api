import mongoose from 'mongoose';

const coinBagSchema = new mongoose.Schema({
  creatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  roomId: {
    type: String,
    required: true,
    index: true,
  },
  roomType: {
    type: String,
    enum: ['voice', 'video'],
    required: true,
    index: true,
  },
  roomTitle: {
    type: String,
    default: '',
  },
  totalCoins: {
    type: Number,
    required: true,
  },
  platformFeeCoins: {
    type: Number,
    required: true,
  },
  claimableCoins: {
    type: Number,
    required: true,
  },
  claimLimit: {
    type: Number,
    required: true,
  },
  claimAmount: {
    type: Number,
    required: true,
  },
  remainingClaims: {
    type: Number,
    required: true,
  },
  undistributedCoins: {
    type: Number,
    default: 0,
  },
  remainingCoins: {
    type: Number,
    required: true,
  },
  status: {
    type: String,
    enum: ['active', 'empty', 'expired'],
    default: 'active',
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, { timestamps: false });

coinBagSchema.index({ roomId: 1, status: 1, expiresAt: 1 });

export default mongoose.model('CoinBag', coinBagSchema);
