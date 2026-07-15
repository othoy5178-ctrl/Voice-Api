import mongoose from "mongoose";

const GameCoinTransactionSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  gameId: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  roundId: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  coin: {
    type: Number,
    required: true,
    min: 0
  },
  type: {
    type: Number,
    enum: [1, 2],
    required: true
  },
  rewardType: {
    type: Number,
    required: true
  },
  winId: {
    type: String,
    default: ''
  },
  roomId: {
    type: String,
    default: ''
  },
  balanceAfter: {
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

export default mongoose.model("GameCoinTransaction", GameCoinTransactionSchema);