import mongoose from 'mongoose';

// Define the slot structure explicitly
const SlotSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  locked: { type: Boolean, default: false },
  uid: { type: Number, default: null },
  username: { type: String, default: null },
  avatar: { type: String, default: null },
  isMe: { type: Boolean, default: false },
  isMuted: { type: Boolean, default: false }
}, { _id: false }); // Prevents Mongoose from adding _id to every single slot

const RoomSchema = new mongoose.Schema({
  channelName: { type: String, required: true, unique: true },
  hostId: { type: String, required: true },
  title: { type: String, default: 'Glix Live Audio Room' },
  createdAt: { type: Date, default: Date.now },
  slots: [SlotSchema] // Uses the sub-schema defined above
});

const Room = mongoose.model('Room', RoomSchema);
export default Room;