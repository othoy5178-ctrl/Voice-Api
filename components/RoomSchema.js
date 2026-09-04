import mongoose from 'mongoose';

// Define the slot structure explicitly
const SlotSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  locked: { type: Boolean, default: false },
  userId: { type: String, default: null },
  uid: { type: Number, default: null },
  username: { type: String, default: null },
  avatar: { type: String, default: null },
  frameUrl: { type: String, default: null },
  isMe: { type: Boolean, default: false },
  isMuted: { type: Boolean, default: false },
  cameraOn: { type: Boolean, default: false }
}, { _id: false }); 

const RoomSchema = new mongoose.Schema({
  channelName: { type: String, required: true, unique: true },
  hostId: { type: String, required: true },
  title: { type: String, default: 'Glix Live Audio Room' },
  isLive: { type: Boolean, default: true },
  lastHeartbeatAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  coverUrl: { type: String, default: '' },
  description: { type: String, default: '' },
  announcement: { type: String, default: '' },
  welcomeMessage: { type: String, default: '' },
  roomTag: { type: String, default: '' },
  roomPassword: { type: String, default: '' },
  automaticSeatInvitation: { type: Boolean, default: true },
  enablePublicChat: { type: Boolean, default: true },
  autoEmojiEnabled: { type: Boolean, default: false },
  activeGamePlayers: [{
    userId: { type: String, default: '' },
    gameId: { type: String, default: '' },
    joinedAt: { type: Date, default: Date.now },
    lastHeartbeatAt: { type: Date, default: Date.now }
  }],
  slots: [SlotSchema] // Uses the sub-schema defined above
});

const Room = mongoose.model('Room', RoomSchema);
export default Room;
