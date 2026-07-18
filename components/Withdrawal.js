import mongoose from 'mongoose';

const withdrawalSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 1
  },
  source: {
    type: String,
    enum: ['daimon', 'commissionBalance', 'revenueBalance'],
    required: true
  },
  method: {
    type: String,
    required: true,
    trim: true
  },
  country: {
    type: String,
    trim: true,
    default: ''
  },
  accountTitle: {
    type: String,
    required: true,
    trim: true
  },
  accountNumber: {
    type: String,
    required: true,
    trim: true
  },
  payoutCurrency: {
    type: String,
    trim: true,
    default: 'PKR'
  },
  exchangeRate: {
    type: Number,
    default: 0
  },
  feePercent: {
    type: Number,
    default: 0
  },
  feeAmount: {
    type: Number,
    default: 0
  },
  payoutAmount: {
    type: Number,
    default: 0
  },
  arrivalText: {
    type: String,
    trim: true,
    default: ''
  },
  proofImageUrl: {
    type: String,
    trim: true,
    default: ''
  },
  note: {
    type: String,
    trim: true,
    default: ''
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  reviewerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reviewNote: {
    type: String,
    trim: true,
    default: ''
  },
  transactionRef: {
    type: String,
    trim: true,
    default: ''
  },
  reviewedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

export default Withdrawal;
