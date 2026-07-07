import mongoose from 'mongoose';

const rewardClaimSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  taskKey: {
    type: String,
    required: true,
    index: true
  },
  claimKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  rewardType: {
    type: String,
    enum: ['daimon', 'chang'],
    default: 'daimon'
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

rewardClaimSchema.index({ userId: 1, taskKey: 1, createdAt: -1 });

const RewardClaim = mongoose.model('RewardClaim', rewardClaimSchema);

export default RewardClaim;
