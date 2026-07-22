import mongoose from 'mongoose';

const roomMusicTrackSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  artist: { type: String, default: '', trim: true },
  type: {
    type: String,
    enum: ['song', 'effect', 'sound_byte'],
    default: 'song',
    index: true,
  },
  url: { type: String, required: true, trim: true },
  coverUrl: { type: String, default: '', trim: true },
  durationMs: { type: Number, default: 0, min: 0 },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isShared: { type: Boolean, default: true, index: true },
  isActive: { type: Boolean, default: true, index: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

roomMusicTrackSchema.index({ isActive: 1, type: 1, sortOrder: 1, createdAt: -1 });

const RoomMusicTrack = mongoose.model('RoomMusicTrack', roomMusicTrackSchema);

export default RoomMusicTrack;
