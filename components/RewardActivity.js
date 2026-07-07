import mongoose from 'mongoose';

const rewardActivitySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

rewardActivitySchema.index({ userId: 1, type: 1, createdAt: -1 });

const RewardActivity = mongoose.model('RewardActivity', rewardActivitySchema);

export default RewardActivity;
