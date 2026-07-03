import mongoose from "mongoose";

const GiftTransactionSchema = new mongoose.Schema({
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Room",
    required: true,
    index: true
  },

  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },

  receiverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },

  giftName: String,
  giftImage: String,

  coinPrice: Number,
  quantity: Number,
  totalCost: Number,

  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

export default mongoose.model("GiftTransaction", GiftTransactionSchema);