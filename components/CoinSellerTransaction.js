import mongoose from 'mongoose';

const coinSellerTransactionSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  buyerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  buyerGlixId: {
    type: String,
    trim: true,
    required: true,
    index: true
  },
  coins: {
    type: Number,
    required: true,
    min: 1
  },
  paymentMethod: {
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
    enum: ['completed', 'reversed'],
    default: 'completed',
    index: true
  },
  sellerBalanceAfter: {
    type: Number,
    default: 0
  },
  buyerCoinsAfter: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

const CoinSellerTransaction = mongoose.model('CoinSellerTransaction', coinSellerTransactionSchema);

export default CoinSellerTransaction;
