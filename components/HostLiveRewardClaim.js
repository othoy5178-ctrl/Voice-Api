import mongoose from 'mongoose';

const hostLiveRewardClaimSchema = new mongoose.Schema({
  hostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  dayKey: {
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
  claimedHourBlock: {
    type: Number,
    required: true,
    min: 1
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

hostLiveRewardClaimSchema.index({ hostId: 1, dayKey: 1, createdAt: -1 });

const HostLiveRewardClaim = mongoose.model('HostLiveRewardClaim', hostLiveRewardClaimSchema);

export default HostLiveRewardClaim;
