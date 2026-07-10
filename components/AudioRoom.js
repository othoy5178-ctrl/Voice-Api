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

  isLive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

const AudioRoom = mongoose.model('AudioRoom', audioRoomSchema);

export default AudioRoom;
