import mongoose from 'mongoose';

const coinBagClaimSchema = new mongoose.Schema({
  coinBagId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CoinBag',
    required: true,
    index: true,
  },
  userId: {
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
  claimedCoins: {
    type: Number,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, { timestamps: false });

coinBagClaimSchema.index({ coinBagId: 1, userId: 1 }, { unique: true });

export default mongoose.model('CoinBagClaim', coinBagClaimSchema);
