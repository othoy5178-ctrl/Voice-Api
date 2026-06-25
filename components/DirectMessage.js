import mongoose from 'mongoose';

const DirectMessageSchema = new mongoose.Schema({
  senderId: { type: String, required: true },
  receiverId: { type: String, required: true },
  text: { type: String, required: true },
  time: { type: String, required: true }, // E.g., "01:35 PM"
  id: {
    type: String,
    unique: true,
    default: () => new mongoose.Types.ObjectId().toString(),
  },
  senderName: { type: String, required: true },
  isRead: { type: Boolean, default: false }, // Useful for unread badge counts later
  createdAt: { type: Date, default: Date.now }
});

// CRITICAL INDEX: Accelerates searching conversations between User A and User B
DirectMessageSchema.index({ senderId: 1, receiverId: 1 });

const DirectMessage = mongoose.model('DirectMessage', DirectMessageSchema);
export default DirectMessage;