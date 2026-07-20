import mongoose from 'mongoose';

const audioRoomSchema = new mongoose.Schema({
  title: { type: String, required: true },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Define fixed slots for speakers (e.g., 5 or 8 slots)
  speakers: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isMuted: { type: Boolean, default: false },
    slotIndex: { type: Number },
    numericUid: { type: Number },
    frameUrl: { type: String, default: null }
  }],

  // Track everyone currently listening
  audience: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  micSeatCount: {
    type: Number,
    enum: [5, 10, 15, 24],
    default: 15
  },
  micLayoutType: {
    type: String,
    enum: ['chatroom', 'dating', 'party', 'birthday'],
    default: 'chatroom'
  },
  backgroundThemeId: { type: String, default: null },
  backgroundThemeUrl: { type: String, default: null },
  lockedSlots: [{ type: Number }],

  isLive: { type: Boolean, default: true },
  lastHeartbeatAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const AudioRoom = mongoose.model('AudioRoom', audioRoomSchema);

export default AudioRoom;

