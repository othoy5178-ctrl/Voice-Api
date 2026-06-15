import mongoose from 'mongoose';

const RoomSchema = new mongoose.Schema({
  channelName: { type: String, required: true, unique: true },
  hostId: { type: String, required: true },
  title: { type: String, default: 'Glix Live Audio Room' },
  createdAt: { type: Date, default: Date.now },
  slots: {
    type: Array,
    default: [
      { id: 1, locked: false, uid: null, username: 'Main Host', avatar: null, isMe: false, isMuted: false },
      { id: 2, locked: false, uid: null, username: 'Co-Host 1', avatar: null, isMe: false, isMuted: false },
      { id: 3, locked: false, uid: null, username: 'Co-Host 2', avatar: null, isMe: false, isMuted: false },
    ]
  }
});
const Room = mongoose.model('Room', RoomSchema);


export default Room;