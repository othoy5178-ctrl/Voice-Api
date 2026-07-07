import mongoose from 'mongoose';

const userStoreItemSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true, index: true },
  itemKey: { type: String, required: true, index: true },
  type: { type: String, required: true, index: true },
  startedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null, index: true },
  isEquipped: { type: Boolean, default: false, index: true },
  createdAt: { type: Date, default: Date.now }
});

userStoreItemSchema.index({ userId: 1, itemKey: 1 }, { unique: true });

const UserStoreItem = mongoose.model('UserStoreItem', userStoreItemSchema);

export default UserStoreItem;
