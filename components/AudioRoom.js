import mongoose from 'mongoose';

const audioRoomSchema = new mongoose.Schema({
  title: { type: String, required: true },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Define fixed slots for speakers (e.g., 5 or 8 slots)
  speakers: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    username: { type: String, default: '' },
    avatar: { type: String, default: '' },
    isMuted: { type: Boolean, default: false },
    slotIndex: { type: Number },
    numericUid: { type: Number },
    frameUrl: { type: String, default: null }
  }],

  // Track everyone currently listening
  audience: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  activeGamePlayers: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    gameId: { type: String, default: '' },
    joinedAt: { type: Date, default: Date.now },
    lastHeartbeatAt: { type: Date, default: Date.now }
  }],

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
  coverUrl: { type: String, default: '' },
  description: { type: String, default: '' },
  announcement: { type: String, default: '' },
  welcomeMessage: { type: String, default: '' },
  roomTag: { type: String, default: '' },
  roomPassword: { type: String, default: '' },
  automaticSeatInvitation: { type: Boolean, default: true },
  enablePublicChat: { type: Boolean, default: true },
  autoEmojiEnabled: { type: Boolean, default: false },

  isPermanent: { type: Boolean, default: false, index: true },
  visibility: {
    type: String,
    enum: ['public', 'followers'],
    default: 'public',
    index: true
  },

  isLive: { type: Boolean, default: true },
  lastHeartbeatAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const AudioRoom = mongoose.model('AudioRoom', audioRoomSchema);

export default AudioRoom;

