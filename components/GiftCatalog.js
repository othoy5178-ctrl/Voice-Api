import mongoose from "mongoose";

const giftCatalogSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  category: { type: String, default: "Popular", trim: true, index: true },
  price: { type: Number, required: true, min: 1 },
  mediaType: { type: String, enum: ["gif", "mp4"], required: true, index: true },
  animationUrl: { type: String, required: true },
  thumbnailUrl: { type: String, default: "" },
  publicId: { type: String, default: "" },
  thumbnailPublicId: { type: String, default: "" },
  isLuckyGift: { type: Boolean, default: false, index: true },
  luckyReturnChance: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true, index: true },
  sortOrder: { type: Number, default: 0 },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "OfficialUser",
    default: null,
  },
}, {
  timestamps: true,
});

giftCatalogSchema.index({ isActive: 1, sortOrder: 1, createdAt: -1 });
giftCatalogSchema.index({ name: 1 });

export default mongoose.model("GiftCatalog", giftCatalogSchema);
