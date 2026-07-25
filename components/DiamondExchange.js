import mongoose from 'mongoose';

const diamondExchangeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  diamonds: {
    type: Number,
    required: true,
    min: 1
  },
  grossCoins: {
    type: Number,
    required: true,
    min: 0
  },
  marginPercent: {
    type: Number,
    default: 10
  },
  marginCoins: {
    type: Number,
    default: 0
  },
  netCoins: {
    type: Number,
    required: true,
    min: 0
  },
  rate: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

const DiamondExchange = mongoose.model('DiamondExchange', diamondExchangeSchema);

export default DiamondExchange;
