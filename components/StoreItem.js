import mongoose from 'mongoose';

const storeItemSchema = new mongoose.Schema({
  itemKey: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  category: { type: String, required: true, index: true },
  section: { type: String, default: 'New This Month', index: true },
  type: { type: String, required: true, index: true },
  price: { type: Number, required: true, min: 0 },
  currency: { type: String, enum: ['daimon', 'chang'], default: 'chang' },
  durationDays: { type: Number, default: 0 },
  imageUrl: { type: String, default: '' },
  previewUrl: { type: String, default: '' },
  assetKey: { type: String, default: '' },
  equipValue: { type: String, default: '' },
  isVipItem: { type: Boolean, default: false, index: true },
  isActive: { type: Boolean, default: true, index: true },
  sortOrder: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const StoreItem = mongoose.model('StoreItem', storeItemSchema);

export default StoreItem;
