import mongoose from 'mongoose';

const profileVisitSchema = new mongoose.Schema({
  profileUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  visitorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  visitedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  visitCount: {
    type: Number,
    default: 1
  }
});

profileVisitSchema.index({ profileUserId: 1, visitorId: 1 }, { unique: true });
profileVisitSchema.index({ profileUserId: 1, visitedAt: -1 });

const ProfileVisit = mongoose.model('ProfileVisit', profileVisitSchema);

export default ProfileVisit;
