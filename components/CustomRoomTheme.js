import mongoose from "mongoose";

const customRoomThemeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  imageUrl: { type: String, required: true },
  thumbnailUrl: { type: String, default: "" },
  publicId: { type: String, default: "" },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected", "expired"],
    default: "pending",
    index: true,
  },
  priceCoins: { type: Number, default: 50000 },
  expiresAt: { type: Date, default: null, index: true },
  approvedAt: { type: Date, default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "OfficialUser", default: null },
  rejectionReason: { type: String, default: "" },
  refundedAt: { type: Date, default: null },
}, { timestamps: true });

customRoomThemeSchema.index({ userId: 1, status: 1, expiresAt: 1 });

const CustomRoomTheme = mongoose.model("CustomRoomTheme", customRoomThemeSchema);

export default CustomRoomTheme;
