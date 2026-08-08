import mongoose from 'mongoose';

const agencyTargetSchema = new mongoose.Schema({
  agencyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  month: {
    type: String,
    required: true,
    index: true,
  },
  targetCoins: {
    type: Number,
    default: 0,
    min: 0,
  },
  achievedCoins: {
    type: Number,
    default: 0,
    min: 0,
  },
  commissionRatePercent: {
    type: Number,
    default: 10,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'achieved', 'failed'],
    default: 'pending',
    index: true,
  },
  note: {
    type: String,
    trim: true,
    default: '',
  },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OfficialUser',
    default: null,
  },
}, {
  timestamps: true,
});

agencyTargetSchema.index({ agencyId: 1, month: 1 }, { unique: true });

const AgencyTarget = mongoose.model('AgencyTarget', agencyTargetSchema);

export default AgencyTarget;
