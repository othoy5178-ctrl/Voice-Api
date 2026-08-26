import mongoose from "mongoose";

const GiftTransactionSchema = new mongoose.Schema({
  roomId: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    index: true
  },

  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  senderName: {
    type: String,
    trim: true,
    default: ''
  },
  senderAvatar: {
    type: String,
    default: ''
  },
  senderGlixId: {
    type: String,
    trim: true,
    default: ''
  },

  receiverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  receiverName: {
    type: String,
    trim: true,
    default: ''
  },
  receiverAvatar: {
    type: String,
    default: ''
  },
  receiverGlixId: {
    type: String,
    trim: true,
    default: ''
  },
  receiverIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],
  receiverCount: {
    type: Number,
    default: 1
  },

  giftName: String,
  giftCatalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "GiftCatalog",
    default: null
  },
  giftImage: String,
  giftThumbnail: {
    type: String,
    default: ''
  },
  giftMediaType: {
    type: String,
    enum: ['gif', 'mp4', 'image', 'unknown'],
    default: 'unknown'
  },

  coinPrice: Number,
  quantity: Number,
  perReceiverCost: Number,
  totalCost: Number,
  batchTotalCost: Number,
  hostShare: { type: Number, default: 0 },
  agencyCommission: { type: Number, default: 0 },
  managerCommission: { type: Number, default: 0 },
  platformCommission: { type: Number, default: 0 },
  commissionMonth: { type: String, trim: true, default: '', index: true },
  commissionDay: { type: String, trim: true, default: '', index: true },
  luckyGift: {
    eligible: { type: Boolean, default: false },
    won: { type: Boolean, default: false },
    chancePercent: { type: Number, default: 0 },
    rewardMultiplier: { type: Number, default: 1 },
    rewardDiamonds: { type: Number, default: 0 }
  },
  roomMode: {
    type: String,
    enum: ['audio', 'video', 'unknown'],
    default: 'unknown',
    index: true
  },
  status: {
    type: String,
    enum: ['completed', 'failed', 'refunded'],
    default: 'completed',
    index: true
  },
  audit: {
    senderBalanceAfter: { type: Number, default: 0 },
    receiverBalanceAfter: { type: Number, default: 0 },
    luckySenderDaimonAfter: { type: Number, default: 0 },
    clientSenderName: { type: String, trim: true, default: '' },
    roomHostId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },

  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

GiftTransactionSchema.index({ senderId: 1, createdAt: -1 });
GiftTransactionSchema.index({ receiverId: 1, createdAt: -1 });
GiftTransactionSchema.index({ roomId: 1, createdAt: -1 });
GiftTransactionSchema.index({ 'audit.roomHostId': 1, createdAt: -1 });

export default mongoose.model("GiftTransaction", GiftTransactionSchema);
