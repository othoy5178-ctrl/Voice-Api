import mongoose from 'mongoose';

const dailyCommissionSchema = new mongoose.Schema({
  beneficiaryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  beneficiaryRole: {
    type: String,
    enum: ['agency', 'manager', 'admin'],
    required: true,
    index: true,
  },
  hostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  day: {
    type: String,
    required: true,
    index: true,
  },
  sourceCoins: {
    type: Number,
    default: 0,
    min: 0,
  },
  commissionAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  ratePercent: {
    type: Number,
    default: 0,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'settled'],
    default: 'pending',
    index: true,
  },
  settledAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

dailyCommissionSchema.index(
  { beneficiaryId: 1, beneficiaryRole: 1, hostId: 1, day: 1 },
  { unique: true }
);

const DailyCommission = mongoose.model('DailyCommission', dailyCommissionSchema);

export default DailyCommission;
