// models/Follow.js
import mongoose from 'mongoose';

const followSchema = new mongoose.Schema({
    followerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    followingId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now }
});

// Create a compound index to ensure one user can only follow another once
// and to optimize "get following" and "get followers" queries
followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
followSchema.index({ followingId: 1 });

const Follow = mongoose.model('Follow', followSchema);

export default Follow;