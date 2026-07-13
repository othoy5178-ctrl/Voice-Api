import 'dotenv/config';
import "./conn.js";
import { Server } from 'socket.io';
import http from 'http';
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import pkg from "agora-token";
import crypto from "crypto";

import User from "./User.js";
import AudioRoom from "./AudioRoom.js";
import Room from "./RoomSchema.js";
import DirectMessage from "./DirectMessage.js";
import Follow from './Follow.js';
import GiftTransaction from './GiftTransation.js';
import RewardActivity from './RewardActivity.js';
import RewardClaim from './RewardClaim.js';
import StoreItem from './StoreItem.js';
import UserStoreItem from './UserStoreItem.js';
import Withdrawal from './Withdrawal.js';
import AuthSession from './AuthSession.js';
import ProfileVisit from './ProfileVisit.js';
import cloudinary from './utils/cloudinary.js';
import bcrypt from "bcryptjs";

const { RtcTokenBuilder, RtcRole } = pkg;
const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

app.use(cors({
  origin: "*",
  methods: ["GET", "PATCH", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.options("*", cors());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Real-time globally synchronized active tracking matrix map (userId -> socket.id)
const activeUsers = {};
const roomMembers = new Map();
const pendingHostDisconnects = new Map();
const audioRoomControllers = new Map();
const HOST_RECONNECT_GRACE_MS = 30000;
const HOST_REVIEWER_ROLES = ['manager', 'admin'];
const WITHDRAW_METHODS = ['Easypaisa', 'JazzCash', 'Bank'];
const MIN_WITHDRAW_AMOUNT = 1000;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const TOKEN_TTL_MS = TOKEN_TTL_SECONDS * 1000;

const createAuthTokenValue = () => crypto
  .randomBytes(48)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

const hashAuthToken = (token) => crypto
  .createHash('sha256')
  .update(String(token || ''))
  .digest('hex');

const signAuthToken = async (user) => {
  const token = createAuthTokenValue();
  await AuthSession.create({
    userId: user._id,
    tokenHash: hashAuthToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS)
  });

  return token;
};

const verifyAuthToken = async (token) => {
  const tokenValue = String(token || '').trim();
  if (!tokenValue) {
    const error = new Error('Invalid auth token');
    error.statusCode = 401;
    throw error;
  }

  const session = await AuthSession.findOneAndUpdate(
    {
      tokenHash: hashAuthToken(tokenValue),
      expiresAt: { $gt: new Date() }
    },
    { $set: { lastUsedAt: new Date() } },
    { new: true }
  ).select('userId').lean();

  if (!session?.userId || !mongoose.Types.ObjectId.isValid(session.userId)) {
    const error = new Error('Invalid auth token');
    error.statusCode = 401;
    throw error;
  }

  return { sub: session.userId.toString() };
};

const requireAuthUser = async (req, res) => {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return null;
  }

  try {
    const payload = await verifyAuthToken(token);
    const user = await User.findById(payload.sub).select('_id role hostStatus').lean();
    if (!user) {
      res.status(401).json({ success: false, message: 'Authentication user not found' });
      return null;
    }
    return user;
  } catch (error) {
    res.status(error.statusCode || 401).json({ success: false, message: error.message || 'Authentication failed' });
    return null;
  }
};

const canCreateLiveRoom = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return false;
  const user = await User.findById(userId).select('_id').lean();
  return !!user;
};

const canClaimRewards = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return false;
  const user = await User.findById(userId).select('role hostStatus').lean();
  return user?.role === 'host' && user.hostStatus === 'approved';
};

const canReviewHostRequests = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return false;
  const user = await User.findById(userId).select('role').lean();
  return !!user && HOST_REVIEWER_ROLES.includes(user.role);
};

const canUseAdminPanel = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return false;
  const user = await User.findById(userId).select('role').lean();
  return user?.role === 'admin';
};

const getWithdrawSourceForRole = (role) => {
  if (role === 'host') return 'daimon';
  if (['agency', 'manager'].includes(role)) return 'commissionBalance';
  if (role === 'admin') return 'revenueBalance';
  return null;
};

const buildWalletSnapshot = (user) => ({
  daimon: user?.daimon || 0,
  chang: user?.chang || 0,
  commissionBalance: user?.commissionBalance || 0,
  revenueBalance: user?.revenueBalance || 0
});

const sanitizeWithdrawalText = (value = '', max = 80) => String(value || '').trim().slice(0, max);

const normalizeAgencyCode = (value = '') => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);

const buildAgencySummary = async (agency) => {
  const hostCount = await User.countDocuments({ agencyId: agency._id });
  const rate = (() => {
    const coins = Number(agency.totalHostCoins || 0);
    if (coins >= 200000000) return 20;
    if (coins >= 130000000) return 16;
    if (coins >= 70000000) return 12;
    if (coins >= 17000000) return 8;
    return 4;
  })();

  return {
    _id: agency._id,
    name: agency.name,
    email: agency.email,
    profilePic: agency.profilePic,
    glixId: agency.glixId,
    agencyCode: agency.agencyCode,
    commissionBalance: agency.commissionBalance || 0,
    totalHostCoins: agency.totalHostCoins || 0,
    hostsCount: hostCount,
    rate,
    createdAt: agency.createdAt
  };
};

const uploadHostVerificationImage = async ({ userId, key, image }) => {
  const base64 = image?.base64;
  if (!base64) throw new Error(`${key} image is required`);

  const mimeType = image?.type || 'image/jpeg';
  if (!mimeType.startsWith('image/')) throw new Error(`${key} must be an image`);
  const missingCloudinaryVars = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
    .filter(envKey => !process.env[envKey]);
  if (missingCloudinaryVars.length) {
    throw new Error(`Cloudinary is not configured. Missing: ${missingCloudinaryVars.join(', ')}`);
  }

  const folder = `${process.env.CLOUDINARY_FOLDER || 'host-verification'}/${userId}`;
  const result = await cloudinary.uploader.upload(`data:${mimeType};base64,${base64}`, {
    folder,
    resource_type: 'image',
    public_id: `${key}-${Date.now()}`
  });

  return result.secure_url;
};

const getRoomMemberList = (roomId) => {
  const members = roomMembers.get(roomId);
  return members
    ? Array.from(members.values()).map(({ userId, name, profilePic }) => ({ userId, name, profilePic }))
    : [];
};

const emitRoomMembers = (roomId) => {
  if (!roomId) return;
  io.to(roomId).emit('room_members_updated', getRoomMemberList(roomId));
};

const upsertRoomMember = (roomId, member) => {
  if (!roomId || !member?.userId) return;
  const members = roomMembers.get(roomId) || new Map();
  members.set(member.userId.toString(), {
    userId: member.userId.toString(),
    name: member.name || 'User',
    profilePic: member.profilePic || '',
    socketId: member.socketId || ''
  });
  roomMembers.set(roomId, members);
  emitRoomMembers(roomId);
};

const removeRoomMember = (roomId, userId, socketId = null) => {
  if (!roomId || !userId) return;
  const members = roomMembers.get(roomId);
  if (!members) return;
  const existing = members.get(userId.toString());
  if (socketId && existing?.socketId && existing.socketId !== socketId) return;
  members.delete(userId.toString());
  if (members.size === 0) {
    roomMembers.delete(roomId);
    return;
  }
  emitRoomMembers(roomId);
};

const closeRoomAfterHostTimeout = async (roomId, hostId) => {
  if (roomId.startsWith('glix_')) {
    const videoRoomDoc = await Room.findOne({ channelName: roomId });
    if (!videoRoomDoc || String(videoRoomDoc.hostId) !== String(hostId)) return;

    io.to(roomId).emit('room_closing', {
      message: 'Host disconnected. Room closed.'
    });
    videoRoomDoc.isLive = false;
    await videoRoomDoc.save();
    roomMembers.delete(roomId);
    console.log(`Video room closed after reconnect grace timeout: ${roomId}`);
    return;
  }

  if (!mongoose.Types.ObjectId.isValid(roomId)) return;
  const audioRoomDoc = await AudioRoom.findById(roomId);
  if (!audioRoomDoc || String(audioRoomDoc.hostId) !== String(hostId)) return;

  audioRoomDoc.isLive = false;
  audioRoomDoc.speakers = [];
  audioRoomDoc.audience = [];
  await audioRoomDoc.save();
  roomMembers.delete(roomId);
  audioRoomControllers.delete(roomId);

  io.to(roomId).emit('audio_room_ended', {
    message: 'Host disconnected. Room closed.'
  });
  console.log(`Audio room closed after reconnect grace timeout: ${roomId}`);
};

const scheduleHostDisconnectClosure = (roomId, hostId) => {
  if (!roomId || !hostId || pendingHostDisconnects.has(roomId)) return;

  io.to(roomId).emit('host_reconnecting', {
    roomId,
    graceMs: HOST_RECONNECT_GRACE_MS,
    message: 'Host connection lost. Waiting for reconnect...'
  });

  const timer = setTimeout(async () => {
    const pending = pendingHostDisconnects.get(roomId);
    if (!pending || String(pending.hostId) !== String(hostId)) return;

    pendingHostDisconnects.delete(roomId);
    try {
      await closeRoomAfterHostTimeout(roomId, hostId);
    } catch (error) {
      console.log('Host reconnect grace timeout close failed:', error);
    }
  }, HOST_RECONNECT_GRACE_MS);

  pendingHostDisconnects.set(roomId, {
    hostId: hostId.toString(),
    timer
  });
};

const clearHostDisconnectClosure = (roomId, hostId) => {
  const pending = pendingHostDisconnects.get(roomId);
  if (!pending || String(pending.hostId) !== String(hostId)) return false;

  clearTimeout(pending.timer);
  pendingHostDisconnects.delete(roomId);
  io.to(roomId).emit('host_reconnected', {
    roomId,
    message: 'Host reconnected.'
  });
  return true;
};

const AUDIO_MIC_SEAT_COUNTS = [5, 10, 15, 24];
const AUDIO_LAYOUT_TYPES = ['chatroom', 'dating', 'party', 'birthday'];
const DEFAULT_AUDIO_MIC_SEAT_COUNT = 15;
const DEFAULT_AUDIO_LAYOUT_TYPE = 'chatroom';
const normalizeAudioMicSeatCount = (count) => {
  const parsed = Number(count);
  return AUDIO_MIC_SEAT_COUNTS.includes(parsed) ? parsed : DEFAULT_AUDIO_MIC_SEAT_COUNT;
};
const normalizeAudioLayoutType = (type) => (
  AUDIO_LAYOUT_TYPES.includes(type) ? type : DEFAULT_AUDIO_LAYOUT_TYPE
);

const createCleanSlotsBlueprint = (count = DEFAULT_AUDIO_MIC_SEAT_COUNT) => Array.from({ length: count }, (_, i) => ({
  id: i + 1,
  locked: i === 3 || i === 12 || i === 19,
  userId: null,
  uid: null,
  username: `${i + 1}`,
  avatar: null,
  frameUrl: null,
  isMuted: false
}));

const buildRoomSlotsSnapshot = async (roomId) => {
  const stringRoomId = roomId ? roomId.toString() : '';

  if (stringRoomId.startsWith('glix_')) {
    const slots = createCleanSlotsBlueprint(25);
    const videoRoomDoc = await Room.findOne({ channelName: stringRoomId }).lean();
    if (videoRoomDoc?.slots) {
      videoRoomDoc.slots.slice(0, 25).forEach((slot, index) => {
        slots[index] = {
          ...slots[index],
          ...slot,
          userId: slot.userId || null,
          uid: slot.uid ?? slot.numericUid ?? null,
          username: slot.username || slot.name || slots[index].username,
          avatar: slot.avatar || slot.profilePic || null,
          frameUrl: slot.frameUrl || null,
          isMuted: !!slot.isMuted,
          cameraOn: !!slot.cameraOn
        };
      });
    }
    return slots;
  }

  if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return createCleanSlotsBlueprint();

  const audioRoomDoc = await AudioRoom.findById(stringRoomId)
    .populate('speakers.userId', 'name profilePic')
    .lean();

  const seatCount = normalizeAudioMicSeatCount(audioRoomDoc?.micSeatCount);
  const slots = createCleanSlotsBlueprint(seatCount);

  if (!audioRoomDoc?.speakers) return slots;

  audioRoomDoc.speakers.filter(speaker => speaker && speaker.userId).forEach(speaker => {
    const index = speaker.slotIndex;
    if (index < 0 || index >= seatCount) return;
    const speakerUserId = speaker.userId?._id || speaker.userId;
    slots[index] = {
      ...slots[index],
      userId: speakerUserId ? speakerUserId.toString() : null,
      uid: speaker.numericUid || null,
      username: speaker.userId?.name || 'Broadcaster',
      avatar: speaker.userId?.profilePic || null,
      frameUrl: speaker.frameUrl || null,
      isMuted: !!speaker.isMuted
    };
  });

  return slots;
};

const emitRoomSlotsSnapshot = async (roomId) => {
  const stringRoomId = roomId ? roomId.toString() : '';
  if (!stringRoomId) return;
  const slots = await buildRoomSlotsSnapshot(stringRoomId);
  io.to(stringRoomId).emit('room_slots_updated', slots);
};

const getSpeakerMatch = (speakers = [], { targetUserId, targetUid, targetSlotIndex }) => {
  const hasTargetSlot = targetSlotIndex !== null && targetSlotIndex !== undefined;
  const normalizedSlotIndex = hasTargetSlot ? Number(targetSlotIndex) : null;

  if (targetUserId) {
    const speaker = speakers.find(item => {
      const speakerUserId = item?.userId?._id || item?.userId;
      return speakerUserId && String(speakerUserId) === String(targetUserId);
    });
    if (speaker) return speaker;
  }

  if (targetUid !== null && targetUid !== undefined) {
    const speaker = speakers.find(item => (
      item?.numericUid !== null &&
      item?.numericUid !== undefined &&
      String(item.numericUid) === String(targetUid)
    ));
    if (speaker) return speaker;
  }

  if (Number.isInteger(normalizedSlotIndex)) {
    return speakers.find(item => Number(item?.slotIndex) === normalizedSlotIndex) || null;
  }

  return null;
};

const isAudioRoomController = (roomId, userId) => {
  if (!roomId || !userId) return false;
  const controllers = audioRoomControllers.get(roomId.toString());
  return !!controllers?.has(userId.toString());
};

const addAudioRoomController = (roomId, userId) => {
  if (!roomId || !userId) return;
  const stringRoomId = roomId.toString();
  const controllers = audioRoomControllers.get(stringRoomId) || new Set();
  controllers.add(userId.toString());
  audioRoomControllers.set(stringRoomId, controllers);
};


const DEFAULT_STORE_ITEMS = [
  { itemKey: 'toyota_ride', name: 'Toyota', category: 'Ride', section: 'New This Month', type: 'ride', price: 400, currency: 'chang', durationDays: 30, assetKey: 'Ride', sortOrder: 1 },
  { itemKey: 'premium_badge', name: 'Premium', category: 'Honor', section: 'New This Month', type: 'badge', price: 30, currency: 'chang', durationDays: 1, assetKey: 'premium', sortOrder: 2 },
  { itemKey: 'jupiter_rare_id', name: 'Jupiter', category: 'Rare ID', section: 'New This Month', type: 'rareId', price: 12, currency: 'chang', durationDays: 7, assetKey: 'RareId', sortOrder: 3 },
  { itemKey: 'gilded_precious_frame', name: 'Gilded Precious', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 400, currency: 'chang', durationDays: 30, assetKey: 'profileBadge', equipValue: 'profileBadge', sortOrder: 4 },
  { itemKey: 'panther_frame', name: 'Panther', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 400, currency: 'chang', durationDays: 30, assetKey: 'higher', equipValue: 'higher', sortOrder: 5 },
  { itemKey: 'lion_king_frame', name: 'Lion King', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 400, currency: 'chang', durationDays: 30, assetKey: 'special', equipValue: 'special', sortOrder: 6 },
  { itemKey: 'honor_star', name: 'Honor Star', category: 'Honor', section: 'Avatar Frame', type: 'badge', price: 250, currency: 'chang', durationDays: 15, assetKey: 'honor-star', sortOrder: 7 },
  { itemKey: 'popular_flower', name: 'Flower Aura', category: 'Popular', section: 'Avatar Frame', type: 'frame', price: 180, currency: 'chang', durationDays: 30, assetKey: 'flower', equipValue: 'flower', sortOrder: 8 },
  { itemKey: 'star_entry_effect', name: 'Star Entry', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 300, currency: 'chang', durationDays: 30, assetKey: 'star', previewUrl: 'https://www.w3schools.com/html/mov_bbb.mp4', equipValue: 'https://www.w3schools.com/html/mov_bbb.mp4', sortOrder: 9 }
];

const ensureDefaultStoreItems = async () => {
  const operations = DEFAULT_STORE_ITEMS.map(item => ({
    updateOne: {
      filter: { itemKey: item.itemKey },
      update: { $set: item },
      upsert: true
    }
  }));

  if (operations.length) await StoreItem.bulkWrite(operations, { ordered: false });
};

const STORE_LIMITED_TYPES = ['frame', 'entryVideo'];

const getStoreDurationDays = (item) => STORE_LIMITED_TYPES.includes(item.type) ? 30 : item.durationDays;

const clearExpiredStoreItems = async (userId, session = null) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return;

  const now = new Date();
  const query = UserStoreItem.find({
    userId,
    isEquipped: true,
    type: { $in: STORE_LIMITED_TYPES },
    expiresAt: { $ne: null, $lte: now }
  });
  if (session) query.session(session);
  const expiredItems = await query.lean();

  if (!expiredItems.length) return;

  const expiredTypes = new Set(expiredItems.map(item => item.type));
  const userUpdate = {};
  if (expiredTypes.has('frame')) userUpdate.frameUrl = '';
  if (expiredTypes.has('entryVideo')) userUpdate.entryVideoUrl = '';

  await UserStoreItem.updateMany(
    { _id: { $in: expiredItems.map(item => item._id) } },
    { $set: { isEquipped: false } },
    { session }
  );

  if (Object.keys(userUpdate).length) {
    await User.findByIdAndUpdate(userId, { $set: userUpdate }, { session });
  }
};

const getStoreWallet = async (userId) => {
  await clearExpiredStoreItems(userId);
  const user = await User.findById(userId).select('daimon chang frameUrl entryVideoUrl');
  if (!user) return null;
  return {
    daimon: user.daimon || 0,
    chang: user.chang || 0,
    frameUrl: user.frameUrl || '',
    entryVideoUrl: user.entryVideoUrl || ''
  };
};

const getStoreExpiry = (item) => {
  const durationDays = getStoreDurationDays(item);
  if (!durationDays || durationDays <= 0) return null;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + durationDays);
  return expiresAt;
};

const getStoreEquipUpdate = (item) => {
  const value = item.type === 'entryVideo'
    ? (item.equipValue || item.previewUrl || item.imageUrl || '')
    : (item.imageUrl || item.equipValue || item.assetKey || '');
  if (item.type === 'frame') return { frameUrl: value };
  if (item.type === 'entryVideo') return { entryVideoUrl: value };
  return null;
};

const generateSevenDigitUserId = () => Math.floor(1000000 + Math.random() * 9000000).toString();

const createUniqueUserPublicId = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const glixId = generateSevenDigitUserId();
    const exists = await User.exists({ glixId });
    if (!exists) return glixId;
  }
  throw new Error('Unable to generate unique user ID');
};

const ensureUserPublicId = async (user) => {
  if (!user || user.glixId) return user;
  const glixId = await createUniqueUserPublicId();
  return User.findByIdAndUpdate(
    user._id,
    { $set: { glixId } },
    { new: true }
  ).select('-password');
};


const REWARD_TASKS = [
  {
    key: 'daily_check_in',
    category: 'Daily',
    title: 'Daily check-in',
    description: 'Claim your daily login reward.',
    target: 1,
    amount: 100,
    rewardType: 'daimon',
    activityTypes: [],
    action: 'claim'
  },
  {
    key: 'join_live_room',
    category: 'Live',
    title: 'Join a live room',
    description: 'Enter any audio or video live room today.',
    target: 1,
    amount: 250,
    rewardType: 'daimon',
    activityTypes: ['join_audio_room', 'join_video_room', 'create_audio_room', 'create_video_room'],
    action: 'go_live'
  },
  {
    key: 'send_gift',
    category: 'Party',
    title: 'Send a gift',
    description: 'Send one gift in a live room today.',
    target: 1,
    amount: 180,
    rewardType: 'daimon',
    activityTypes: ['send_gift'],
    action: 'go_party'
  },
  {
    key: 'follow_user',
    category: 'Social',
    title: 'Follow a creator',
    description: 'Follow one user today.',
    target: 1,
    amount: 150,
    rewardType: 'daimon',
    activityTypes: ['follow_user'],
    action: 'go_profile'
  }
];

const getRewardDayRange = (date = new Date()) => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end, dayKey: start.toISOString().slice(0, 10) };
};
const DAILY_CHECK_IN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const getDailyCheckInAvailability = async (userId, now = new Date()) => {
  const lastClaim = await RewardClaim.findOne({ userId, taskKey: 'daily_check_in' })
    .sort({ createdAt: -1 })
    .lean();

  if (!lastClaim) {
    return {
      claimed: false,
      canClaim: true,
      lastClaimedAt: null,
      nextClaimAt: null
    };
  }

  const nextClaimAt = new Date(new Date(lastClaim.createdAt).getTime() + DAILY_CHECK_IN_COOLDOWN_MS);
  const canClaim = now >= nextClaimAt;

  return {
    claimed: !canClaim,
    canClaim,
    lastClaimedAt: lastClaim.createdAt,
    nextClaimAt: nextClaimAt.toISOString()
  };
};

const recordRewardActivity = async (userId, type, metadata = {}) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(userId)) return;
    await RewardActivity.create({ userId, type, metadata });
  } catch (error) {
    console.warn(`Reward activity skipped: ${error.message}`);
  }
};

const getRewardProgress = async (userId, task, start, end) => {
  if (task.key === 'daily_check_in') return 1;
  return RewardActivity.countDocuments({
    userId,
    type: { $in: task.activityTypes },
    createdAt: { $gte: start, $lt: end }
  });
};

const buildRewardDashboard = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    const error = new Error('Invalid user id');
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findById(userId).select('daimon chang name glixId');
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const now = new Date();
  const { start, end, dayKey } = getRewardDayRange(now);
  const claims = await RewardClaim.find({ userId, createdAt: { $gte: start, $lt: end } }).lean();
  const claimedTaskKeys = new Set(claims.map(claim => claim.taskKey));
  const dailyCheckInAvailability = await getDailyCheckInAvailability(userId, now);

  const groupedEarnings = await RewardClaim.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId), createdAt: { $gte: start, $lt: end } } },
    { $group: { _id: '$rewardType', total: { $sum: '$amount' } } }
  ]);

  const todayEarnings = groupedEarnings.reduce((acc, item) => {
    acc[item._id] = item.total;
    return acc;
  }, { daimon: 0, chang: 0 });

  const tasks = await Promise.all(REWARD_TASKS.map(async task => {
    const rawProgress = await getRewardProgress(userId, task, start, end);
    const progress = Math.min(rawProgress, task.target);
    const isDailyCheckIn = task.key === 'daily_check_in';
    const claimed = isDailyCheckIn ? dailyCheckInAvailability.claimed : claimedTaskKeys.has(task.key);
    const canClaim = isDailyCheckIn ? dailyCheckInAvailability.canClaim : progress >= task.target && !claimed;

    return {
      ...task,
      progress,
      claimed,
      canClaim,
      ...(isDailyCheckIn ? {
        lastClaimedAt: dailyCheckInAvailability.lastClaimedAt,
        nextClaimAt: dailyCheckInAvailability.nextClaimAt
      } : {})
    };
  }));

  return {
    success: true,
    dayKey,
    nextResetAt: end.toISOString(),
    wallet: {
      daimon: user.daimon || 0,
      chang: user.chang || 0
    },
    todayEarnings,
    tasks
  };
};

const getRoomGiftTotals = async (roomId) => {
  const roomMatchValues = [roomId?.toString()];
  if (mongoose.Types.ObjectId.isValid(roomId)) {
    roomMatchValues.push(new mongoose.Types.ObjectId(roomId));
  }

  const [totals] = await GiftTransaction.aggregate([
    { $match: { roomId: { $in: roomMatchValues } } },
    {
      $group: {
        _id: '$roomId',
        totalCoins: { $sum: '$totalCost' },
        totalGifts: { $sum: '$quantity' },
        totalTransactions: { $sum: 1 }
      }
    }
  ]);

  return totals || { totalCoins: 0, totalGifts: 0, totalTransactions: 0 };
};

const emitRoomStats = async (roomId) => {
  const stringRoomId = roomId ? roomId.toString() : '';
  if (!stringRoomId) return;

  const members = io.sockets.adapter.rooms.get(stringRoomId);
  const memberCount = members ? members.size : 0;
  const totals = await getRoomGiftTotals(stringRoomId);
  const popularityScore = (totals.totalCoins || 0) + (memberCount * 100);

  io.to(stringRoomId).emit('room_stats', {
    roomId: stringRoomId,
    memberCount,
    totalCoins: totals.totalCoins || 0,
    totalGifts: totals.totalGifts || 0,
    popularityScore
  });
};
io.on('connection', (socket) => {
  console.log(`User connected to socket cluster: ${socket.id}`);

  // 1. EVENT: Join Room
  socket.on('join_audio_room', async ({ roomId, userId, numericUid, name, profilePic, entryVideoUrl }) => {
    try {
      await clearExpiredStoreItems(userId);
      const userData = await User.findById(userId).select('frameUrl entryVideoUrl');
      const frameUrl = userData?.frameUrl || null;

      const stringRoomId = roomId ? roomId.toString() : '';
      socket.join(stringRoomId);
      socket.roomId = stringRoomId;
      socket.userId = userId;
      socket.numericUid = numericUid;
      socket.userName = name;

      // Map connection instance to verify host mappings directly on requests
      if (userId) {
        activeUsers[userId.toString()] = socket.id;
      }

      let roomHostId = null;
      if (stringRoomId.startsWith('glix_')) {
        const roomDoc = await Room.findOne({ channelName: stringRoomId }).select('hostId');
        roomHostId = roomDoc?.hostId || null;
      } else if (mongoose.Types.ObjectId.isValid(stringRoomId)) {
        const audioRoomDoc = await AudioRoom.findById(stringRoomId).select('hostId');
        roomHostId = audioRoomDoc?.hostId || null;
      }

      if (roomHostId && String(roomHostId) === String(userId)) {
        clearHostDisconnectClosure(stringRoomId, userId);
      }

      console.log(`${name} joined real-time room channel: ${stringRoomId}`);

      upsertRoomMember(stringRoomId, {
        userId,
        name,
        profilePic,
        socketId: socket.id
      });

      const finalEntryVideoUrl = userData?.entryVideoUrl || entryVideoUrl || null;

      socket.to(stringRoomId).emit('user_joined_channel', {
        userId,
        name,
        profilePic,
        entryVideoUrl: finalEntryVideoUrl,
        frameUrl: frameUrl || null,
        message: `${name} entered the room.`
      });

      if (finalEntryVideoUrl) {
        socket.emit('play_my_own_entry_effect', { entryVideoUrl: finalEntryVideoUrl });
      }

      const completeLayoutMatrix = await buildRoomSlotsSnapshot(stringRoomId);

      socket.emit('initialize_room_slots', completeLayoutMatrix);
      await emitRoomStats(stringRoomId);

    } catch (err) {
      console.log("Error inside join initialization workflow logic: ", err);
    }
  });

  // 2. EVENT: Request Slot Change
  socket.on('request_slot_change', async ({ roomId, userId, name, profilePic, frameUrl, targetSlotIndex, numericUid, isMuted, locked, cameraOn }) => {
    try {
      const stringRoomId = roomId ? roomId.toString() : '';

      if (typeof locked === 'boolean') {
        io.to(stringRoomId).emit('slot_lock_changed', {
          slotIndex: targetSlotIndex,
          locked
        });
        return;
      }

      let finalFrameUrl = frameUrl;

      // Fetch from DB only if the client didn't send a frameUrl
      if (!finalFrameUrl) {
        const dbUser = await User.findById(userId).select('frameUrl');
        finalFrameUrl = dbUser?.frameUrl || null;
      }

      const isVideoRoom = stringRoomId.startsWith('glix_');
      const queryFilter = isVideoRoom ? { channelName: stringRoomId } : { _id: stringRoomId };

      if (isVideoRoom) {
        const videoRoom = await Room.findOne({ channelName: stringRoomId });
        if (!videoRoom) {
          socket.emit('error_notice', { message: 'Video room not found.' });
          return;
        }

        const normalizedTargetSlotIndex = Number(targetSlotIndex);
        if (normalizedTargetSlotIndex < 0 || normalizedTargetSlotIndex >= 3) {
          socket.emit('error_notice', { message: 'This video slot is not available.' });
          return;
        }

        const incomingUid = numericUid !== null && numericUid !== undefined ? parseInt(numericUid, 10) : null;
        const incomingUserId = userId ? userId.toString() : null;

        const resetVideoSlotDoc = (slot, index) => {
          slot.userId = null;
          slot.uid = null;
          slot.username = index === 0 ? 'Main Host' : `Co-Host ${index}`;
          slot.avatar = null;
          slot.frameUrl = null;
          slot.isMuted = false;
          slot.cameraOn = index === 0;
        };

        videoRoom.slots.forEach((slot, index) => {
          const sameTarget = index === normalizedTargetSlotIndex;
          const sameUser = incomingUserId && slot.userId && String(slot.userId) === incomingUserId;
          const sameUid = incomingUid !== null && slot.uid !== null && slot.uid !== undefined && String(slot.uid) === String(incomingUid);
          if (sameTarget || sameUser || sameUid) resetVideoSlotDoc(slot, index);
        });

        if (profilePic !== null) {
          const targetSlot = videoRoom.slots[normalizedTargetSlotIndex];
          targetSlot.userId = incomingUserId;
          targetSlot.uid = incomingUid;
          targetSlot.username = name || (normalizedTargetSlotIndex === 0 ? 'Main Host' : `Co-Host ${normalizedTargetSlotIndex}`);
          targetSlot.avatar = profilePic || null;
          targetSlot.frameUrl = finalFrameUrl || null;
          targetSlot.isMuted = !!isMuted;
          targetSlot.cameraOn = typeof cameraOn === 'boolean' ? cameraOn : normalizedTargetSlotIndex === 0;
        }

        await videoRoom.save();
      } else {
        if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return;
        const roomMeta = await AudioRoom.findById(stringRoomId).select('micSeatCount').lean();
        const seatCount = normalizeAudioMicSeatCount(roomMeta?.micSeatCount);
        if (Number(targetSlotIndex) < 0 || Number(targetSlotIndex) >= seatCount) {
          socket.emit('error_notice', { message: 'This mic slot is not available in the current arrangement.' });
          return;
        }

        if (profilePic === null) {
          await AudioRoom.findOneAndUpdate(queryFilter, {
            $pull: { speakers: { slotIndex: targetSlotIndex } }
          });
        } else {
          if (!finalFrameUrl) {
            const existingRoom = await AudioRoom.findById(stringRoomId).select('speakers').lean();
            const existingSpeaker = existingRoom?.speakers?.find(speaker => (
              (speaker?.userId && String(speaker.userId) === String(userId)) ||
              Number(speaker?.slotIndex) === Number(targetSlotIndex)
            ));
            finalFrameUrl = existingSpeaker?.frameUrl || null;
          }

          await AudioRoom.findOneAndUpdate(queryFilter, {
            $pull: { speakers: { $or: [{ userId: userId }, { slotIndex: targetSlotIndex }] } }
          });

          await AudioRoom.findOneAndUpdate(queryFilter, {
            $push: {
              speakers: {
                userId: userId,
                slotIndex: targetSlotIndex,
                numericUid: parseInt(numericUid, 10),
                isMuted: isMuted || false,
                frameUrl: finalFrameUrl
              }
            }
          });
        }
      }

      io.to(stringRoomId).emit('slot_state_changed', {
        slotIndex: targetSlotIndex,
        user: {
          uid: numericUid ? parseInt(numericUid, 10) : null,
          userId,
          username: name,
          avatar: profilePic,
          frameUrl: finalFrameUrl,
          isMuted: isMuted || false,
          cameraOn: !!cameraOn
        }
      });
      await emitRoomSlotsSnapshot(stringRoomId);

    } catch (error) {
      console.log("Socket array persistence exception error:", error);
      socket.emit('error_notice', { message: 'Failed to synchronize layout seat state.' });
    }
  });

  socket.on('update_audio_room_layout', async ({ roomId, requesterId, micSeatCount, micLayoutType }) => {
    try {
      const stringRoomId = roomId ? roomId.toString() : '';
      const actingUserId = requesterId || socket.userId;

      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) {
        socket.emit('error_notice', { message: 'Invalid audio room.' });
        return;
      }

      const room = await AudioRoom.findById(stringRoomId).select('hostId speakers micSeatCount micLayoutType');
      if (!room) {
        socket.emit('error_notice', { message: 'Audio room not found.' });
        return;
      }

      const canChangeLayout = String(room.hostId) === String(actingUserId) || isAudioRoomController(stringRoomId, actingUserId);
      if (!canChangeLayout) {
        socket.emit('error_notice', { message: 'Only the host can change mic arrangement.' });
        return;
      }

      const requestedCount = micSeatCount === undefined || micSeatCount === null
        ? normalizeAudioMicSeatCount(room.micSeatCount)
        : Number(micSeatCount);
      if (!AUDIO_MIC_SEAT_COUNTS.includes(Number(requestedCount))) {
        socket.emit('error_notice', { message: 'Invalid mic seat count.' });
        return;
      }

      const nextSeatCount = Number(requestedCount);
      const nextLayoutType = micLayoutType === undefined || micLayoutType === null
        ? normalizeAudioLayoutType(room.micLayoutType)
        : normalizeAudioLayoutType(micLayoutType);

      const occupiedOutsideLayout = (room.speakers || []).some(speaker => (
        speaker?.userId &&
        Number(speaker.slotIndex) >= nextSeatCount
      ));

      if (occupiedOutsideLayout) {
        socket.emit('error_notice', { message: 'Please clear higher mic slots before reducing seats.' });
        return;
      }

      await AudioRoom.findByIdAndUpdate(stringRoomId, {
        $set: {
          micSeatCount: nextSeatCount,
          micLayoutType: nextLayoutType
        }
      });

      const slots = await buildRoomSlotsSnapshot(stringRoomId);
      io.to(stringRoomId).emit('room_layout_changed', {
        micSeatCount: nextSeatCount,
        micLayoutType: nextLayoutType,
        slots
      });
    } catch (error) {
      console.log('Audio room layout update error:', error);
      socket.emit('error_notice', { message: 'Failed to update mic arrangement.' });
    }
  });

  socket.on('assign_audio_room_host', async ({ roomId, requesterId, targetUserId, targetUid, targetSlotIndex }) => {
    try {
      const stringRoomId = roomId ? roomId.toString() : '';
      const actingUserId = requesterId || socket.userId;

      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) {
        socket.emit('error_notice', { message: 'Invalid audio room.' });
        return;
      }

      const room = await AudioRoom.findById(stringRoomId)
        .populate('speakers.userId', 'name profilePic')
        .select('hostId speakers isLive');

      if (!room || !room.isLive) {
        socket.emit('error_notice', { message: 'Audio room is not live.' });
        return;
      }

      if (!actingUserId || String(room.hostId) !== String(actingUserId)) {
        socket.emit('error_notice', { message: 'Only the current host can assign hosting.' });
        return;
      }

      const targetSpeaker = getSpeakerMatch(room.speakers, { targetUserId, targetUid, targetSlotIndex });
      const nextHostUserId = targetSpeaker?.userId?._id || targetSpeaker?.userId;

      if (!targetSpeaker || !nextHostUserId) {
        socket.emit('error_notice', { message: 'Selected user must be on a mic slot.' });
        return;
      }

      addAudioRoomController(stringRoomId, nextHostUserId);

      const pending = pendingHostDisconnects.get(stringRoomId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingHostDisconnects.delete(stringRoomId);
      }

      const assignedHostPayload = {
        roomId: stringRoomId,
        hostId: room.hostId.toString(),
        assignedHostId: nextHostUserId.toString(),
        assignedByUserId: actingUserId.toString(),
        controller: {
          userId: nextHostUserId.toString(),
          uid: targetSpeaker.numericUid ?? null,
          username: targetSpeaker.userId?.name || 'Host',
          avatar: targetSpeaker.userId?.profilePic || null,
          frameUrl: targetSpeaker.frameUrl || null,
          slotIndex: targetSpeaker.slotIndex,
        },
        message: `${targetSpeaker.userId?.name || 'A mic user'} can now manage this room with the host.`
      };

      io.to(stringRoomId).emit('audio_room_host_assigned', assignedHostPayload);
      await emitRoomSlotsSnapshot(stringRoomId);
    } catch (error) {
      console.log('Assign audio room host error:', error);
      socket.emit('error_notice', { message: 'Failed to assign room host.' });
    }
  });

  socket.on('remove_audio_mic_user', async ({ roomId, requesterId, targetUserId, targetUid, targetSlotIndex }) => {
    try {
      const stringRoomId = roomId ? roomId.toString() : '';
      const actingUserId = requesterId || socket.userId;

      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) {
        socket.emit('error_notice', { message: 'Invalid audio room.' });
        return;
      }

      const room = await AudioRoom.findById(stringRoomId)
        .populate('speakers.userId', 'name profilePic')
        .select('hostId speakers isLive');

      if (!room || !room.isLive) {
        socket.emit('error_notice', { message: 'Audio room is not live.' });
        return;
      }

      const actingSpeaker = getSpeakerMatch(room.speakers, { targetUserId: actingUserId });
      const actingUserIsHost = actingUserId && String(room.hostId) === String(actingUserId);
      const actingUserIsController = isAudioRoomController(stringRoomId, actingUserId) && !!actingSpeaker;

      if (!actingUserIsHost && !actingUserIsController) {
        socket.emit('error_notice', { message: 'Only the host or assigned controller can remove users from mic.' });
        return;
      }

      const targetSpeaker = getSpeakerMatch(room.speakers, { targetUserId, targetUid, targetSlotIndex });
      const removedUserId = targetSpeaker?.userId?._id || targetSpeaker?.userId;

      if (!targetSpeaker || !removedUserId) {
        socket.emit('error_notice', { message: 'Selected user is not on a mic slot.' });
        return;
      }

      if (String(removedUserId) === String(room.hostId)) {
        socket.emit('error_notice', { message: 'Host cannot be removed from mic using this option.' });
        return;
      }

      await AudioRoom.findByIdAndUpdate(stringRoomId, {
        $pull: { speakers: { userId: removedUserId } },
        $addToSet: { audience: removedUserId }
      });

      const removedSlotIndex = targetSpeaker.slotIndex;
      const removedPayload = {
        roomId: stringRoomId,
        targetUserId: removedUserId.toString(),
        targetUid: targetSpeaker.numericUid ?? null,
        targetSlotIndex: removedSlotIndex,
        message: 'The host removed you from the mic slot.'
      };

      io.to(stringRoomId).emit('audio_mic_user_removed', removedPayload);
      io.to(stringRoomId).emit('slot_state_changed', {
        slotIndex: removedSlotIndex,
        user: {
          uid: null,
          userId: null,
          username: "",
          avatar: null,
          frameUrl: null,
          isMuted: false
        }
      });
      await emitRoomSlotsSnapshot(stringRoomId);
    } catch (error) {
      console.log('Remove audio mic user error:', error);
      socket.emit('error_notice', { message: 'Failed to remove mic user.' });
    }
  });

  socket.on('send_expressive_emoji', (payload = {}) => {
    const stringRoomId = payload.roomId ? payload.roomId.toString() : '';
    if (!stringRoomId) return;

    io.to(stringRoomId).emit('receive_expressive_emoji', {
      ...payload,
      id: payload.id || Date.now().toString() + Math.random().toString(),
      type: 'expressive_emoji',
      emoji: payload.emoji || payload.text,
      text: payload.text || payload.emoji,
      animationKey: payload.animationKey || payload.emojiId || null,
      emojiId: payload.emojiId || payload.animationKey || null
    });
  });

  // 3. EVENT: Chat Messages
  socket.on('send_message', ({ roomId, senderName, text, userId, type, emoji, animationKey, emojiId, numericUid, targetSlotIndex }) => {
    const stringRoomId = roomId ? roomId.toString() : '';
    if (type === 'expressive_emoji') {
      io.to(stringRoomId).emit('receive_message', {
        id: Date.now().toString() + Math.random().toString(),
        type: 'expressive_emoji',
        sender: senderName,
        senderName,
        text: text || emoji,
        emoji: emoji || text,
        animationKey: animationKey || emojiId || null,
        emojiId: emojiId || animationKey || null,
        userId,
        numericUid,
        targetSlotIndex
      });
      return;
    }

    io.to(stringRoomId).emit('receive_message', {
      id: Date.now().toString() + Math.random().toString(),
      type: 'user',
      sender: senderName,
      text: text,
      userId: userId
    });
  });

  socket.on('send_gift', async ({ roomId, senderName, hostId, receiverIds, gift, giftName, avatar, userId, quantity, coins }) => {

    console.log('gift data:', userId, roomId, hostId, coins);

    const targetIds = Array.from(new Set(
      (Array.isArray(receiverIds) && receiverIds.length ? receiverIds : [hostId])
        .filter(id => id && mongoose.Types.ObjectId.isValid(id))
        .map(id => id.toString())
    ));

    if (!targetIds.length) {
      console.error("Backend Error: Received no valid gift receivers!");
      socket.emit('gift_error', { message: "Invalid receiver ID received." });
      return;
    }

    const coinPrice = Number(coins);
    const giftQuantity = Number(quantity);

    if (!Number.isFinite(coinPrice) || !Number.isFinite(giftQuantity) || coinPrice <= 0 || giftQuantity <= 0) {
      socket.emit('gift_error', { message: "Invalid gift cost received." });
      return;
    }

    const perReceiverCost = coinPrice * giftQuantity;
    const totalCost = perReceiverCost * targetIds.length;

    const session = await mongoose.startSession();
    session.startTransaction();


    try {
      const sender = await User.findOneAndUpdate(
        { _id: userId, chang: { $gte: totalCost } },
        { $inc: { chang: -totalCost } },
        { new: true, session }
      );

      if (!sender) throw new Error("Insufficient coins");

      // 2. Add earned diamonds to selected receivers.
      const receiverUpdate = await User.updateMany(
        { _id: { $in: targetIds } },
        { $inc: { daimon: perReceiverCost } },
        { session }
      );

      if (receiverUpdate.matchedCount !== targetIds.length) throw new Error("Gift receiver not found");

      await GiftTransaction.create(targetIds.map(receiverId => ({
        roomId: roomId?.toString(),
        senderId: userId,
        receiverId,
        giftName,
        giftImage: gift,
        coinPrice,
        quantity: giftQuantity,
        totalCost: perReceiverCost
      })), { session });


      await session.commitTransaction();
      await recordRewardActivity(userId, 'send_gift', { roomId: roomId?.toString(), totalCost });

    } catch (error) {
      await session.abortTransaction();
      // Emit error back to the sender only
      socket.emit('gift_error', { message: error.message });
      return;
    } finally {
      session.endSession();
    }
    const stringRoomId = roomId ? roomId.toString() : '';
    io.to(stringRoomId).emit('receive_gift', {
      id: Date.now().toString() + Math.random().toString(),
      type: 'gift',
      sender: senderName,
      gift: gift,
      giftName: giftName,
      avatar: avatar,
      quantity: giftQuantity,
      perReceiverCost,
      totalCost,
      receiverIds: targetIds,
      userId: userId
    });
    await emitRoomStats(stringRoomId);
  });

  // 5. EVENT: Audience Mic Requests (Correctly Un-nested now)
  socket.on('audience_join_request', (data) => {
    if (!data?.hostId || !data?.roomId) return;

    const controllerId = data.controllerUserId ? String(data.controllerUserId) : null;
    const hostSocketId = activeUsers[String(data.hostId)];
    const controllerSocketId = controllerId ? activeUsers[controllerId] : null;
    const targetSocketId = data.hostAway && controllerSocketId ? controllerSocketId : hostSocketId;

    if (targetSocketId) {
      io.to(targetSocketId).emit('receive_join_request', data);
    } else if (controllerSocketId) {
      io.to(controllerSocketId).emit('receive_join_request', data);
    } else {
      io.to(String(data.roomId)).emit('receive_join_request', data);
    }
  });

  // 6. EVENT: Host Acceptance Decision System Handler
  socket.on('host_request_response', async (data) => {
    try {
      const stringRoomId = data.roomId?.toString();

      // Send response to all users
      io.to(stringRoomId).emit('join_request_result', data);

      // If request rejected, stop here
      if (!data.accepted || !data.user) return;
      const acceptedUserId = data.user.userId || data.user._id || data.user.id || data.userId;
      if (!acceptedUserId) {
        console.warn('Accepted mic request missing database userId:', data);
        return;
      }

      // ===========================
      // UPDATE DATABASE
      // ===========================

      await AudioRoom.findByIdAndUpdate(data.roomId, {
        $pull: {
          audience: acceptedUserId
        }
      });

      await AudioRoom.findByIdAndUpdate(data.roomId, {
        $pull: {
          speakers: {
            $or: [
              { userId: acceptedUserId },
              { slotIndex: data.requestedSlotIndex },
              { userId: { $exists: false } },
              { userId: null }
            ]
          }
        }
      });

      await AudioRoom.findByIdAndUpdate(data.roomId, {
        $push: {
          speakers: {
            userId: acceptedUserId,
            slotIndex: data.requestedSlotIndex,
            numericUid: data.user.uid,
            frameUrl: data.user.frameUrl || null,
            isMuted: false
          }
        }
      });

      // ===========================
      // UPDATE ALL CLIENTS
      // ===========================

      io.to(stringRoomId).emit('slot_state_changed', {
        slotIndex: data.requestedSlotIndex,
        user: {
          uid: data.user.uid,
          userId: acceptedUserId,
          username: data.user.username,
          avatar: data.user.avatar,
          frameUrl: data.user.frameUrl || null,
          isMuted: false
        }
      });
      await emitRoomSlotsSnapshot(stringRoomId);

    } catch (err) {
      console.log("Host response error:", err);
    }
  });

  socket.on('register_user', (userId) => {
    if (userId) {
      socket.join(userId.toString());
      console.log(`✅ SUCCESS: User ${userId} joined room: ${userId}`);
      // Send a confirmation back to the client to verify connection
      socket.emit('system_message', `Successfully joined room: ${userId}`);
    } else {
      console.log("❌ ERROR: Attempted to join room with empty userId");
    }
  });

  socket.on('send_direct_message', async (data) => {
    const { senderId, receiverId, text, senderName, time, localId } = data;

    console.log('DM:', data);

    try {
      const dm = new DirectMessage({ senderId, receiverId, text, senderName, time });
      const savedMessage = await dm.save();
      const serverPayload = {
        _id: savedMessage._id.toString(),
        senderId,
        receiverId,
        text,
        senderName,
        time
      };

      // TARGET THE ROOM NAME
      io.to(receiverId.toString()).emit('receive_direct_message', serverPayload);

      // Echo back to sender
      socket.emit('message_sent_ack', { localId, _id: savedMessage._id.toString() });

    } catch (err) {
      console.error('DB Error:', err);
    }
  });
  socket.on('mark_messages_read', async ({ userId, partnerId }) => {
    try {
      // 1. Update all messages sent by the partner to me that are currently unread
      await DirectMessage.updateMany(
        { senderId: partnerId, receiverId: userId, isRead: false },
        { $set: { isRead: true } }
      );

      // 2. Notify the sender (partner) that their messages have been read
      // So the sender can update their UI in real-time
      const partnerSocketId = activeUsers[partnerId];
      if (partnerSocketId) {
        io.to(partnerSocketId).emit('messages_read_receipt', { readerId: userId });
      }

      console.log(`Marked messages from ${partnerId} as read by ${userId}`);
    } catch (err) {
      console.error('Error marking messages as read:', err);
    }
  });

  socket.on('get_chat_history', async ({ userId, partnerId }) => {
    console.log(`Fetching history for: ${userId} <-> ${partnerId}`);
    try {
      const history = await DirectMessage.find({
        $or: [
          { senderId: userId, receiverId: partnerId },
          { senderId: partnerId, receiverId: userId }
        ]
      })
        .sort({ createdAt: 1 })
        .limit(100);

      console.log(`Found ${history.length} messages.`);
      socket.emit('load_chat_history', history);
    } catch (err) {
      console.error('Error fetching history:', err);
    }
  });

  socket.on('get_chat_list', async ({ userId }) => {
    console.log("🔍 Server received request for chat list. UserID:", userId);
    try {
      const chatList = await DirectMessage.aggregate([
        { $match: { $or: [{ senderId: userId }, { receiverId: userId }] } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: {
              $cond: [{ $eq: ["$senderId", userId] }, "$receiverId", "$senderId"]
            },
            lastMessage: { $first: "$text" },
            lastTimestamp: { $first: "$time" },
            unreadCount: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$receiverId", userId] }, { $eq: ["$isRead", false] }] },
                  1,
                  0
                ]
              }
            }
          }
        },
        // 4. Lookup: Fetch user details from 'users' collection
        {
          $lookup: {
            from: 'users',
            let: { pId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: [
                      "$_id",
                      {
                        $convert: {
                          input: "$$pId",
                          to: "objectId",
                          onError: null, // <--- THIS PREVENTS THE CRASH
                          onNull: null
                        }
                      }
                    ]
                  }
                }
              }
            ],
            as: 'partnerDetails'
          }
        },

        // 5. Flatten: Convert array to object
        { $unwind: { path: "$partnerDetails", preserveNullAndEmptyArrays: true } },

        // 6. Project: Clean up the output
        {
          $project: {
            _id: 0,
            partnerId: "$_id",
            lastMessage: 1,
            lastTimestamp: 1,
            unreadCount: 1,
            partnerName: { $ifNull: ["$partnerDetails.name", "Unknown User"] },
            profilePic: { $ifNull: ["$partnerDetails.profilePic", ""] }
          }
        },
        { $sort: { lastTimestamp: -1 } }
      ]);

      socket.emit('load_chat_list', chatList);
      console.log('chat List:', chatList);
    } catch (err) {
      console.error('Error fetching chat list:', err);
      socket.emit('error_notice', { message: 'Failed to load chat list.' });
    }
  });

  // 7. EVENT: Safe Disconnect Handler
  socket.on('disconnect', async () => {
    try {
      if (socket.userId) {
        const userKey = socket.userId.toString();
        if (activeUsers[userKey] === socket.id) {
          delete activeUsers[userKey];
        }
      } else {
        // Find key by value (the socket.id) to clean up if we didn't store userId on socket object
        for (const userId in activeUsers) {
          if (activeUsers[userId] === socket.id) {
            delete activeUsers[userId];
          }
        }
      }

      if (!socket.roomId || !socket.userId) return;

      const roomId = socket.roomId.toString();
      const currentUserId = socket.userId.toString();
      const currentNumericUid = socket.numericUid;
      removeRoomMember(roomId, currentUserId, socket.id);

      if (roomId.startsWith('glix_')) {
        const videoRoomDoc = await Room.findOne({ channelName: roomId });

        if (
          videoRoomDoc &&
          videoRoomDoc.hostId &&
          videoRoomDoc.hostId.toString() === currentUserId
        ) {
          scheduleHostDisconnectClosure(roomId, currentUserId);
          console.log(`Video room host disconnected, waiting for reconnect: ${roomId}`);
        } else if (videoRoomDoc?.slots?.length) {
          const removedSlotIndexes = [];
          videoRoomDoc.slots.forEach((slot, index) => {
            const slotMatchesUser = slot.userId && String(slot.userId) === currentUserId;
            const slotMatchesUid = currentNumericUid !== null && currentNumericUid !== undefined && slot.uid !== null && slot.uid !== undefined && String(slot.uid) === String(currentNumericUid);
            if (slotMatchesUser || slotMatchesUid) {
              slot.userId = null;
              slot.uid = null;
              slot.username = index === 0 ? 'Main Host' : `Co-Host ${index}`;
              slot.avatar = null;
              slot.frameUrl = null;
              slot.isMuted = false;
              slot.cameraOn = index === 0;
              removedSlotIndexes.push(index);
            }
          });

          if (removedSlotIndexes.length) {
            await videoRoomDoc.save();
            removedSlotIndexes.forEach(slotIndex => {
              io.to(roomId).emit('slot_state_changed', {
                slotIndex,
                user: {
                  uid: null,
                  userId: null,
                  username: slotIndex === 0 ? 'Main Host' : `Co-Host ${slotIndex}`,
                  avatar: null,
                  frameUrl: null,
                  isMuted: false,
                  cameraOn: slotIndex === 0
                }
              });
            });
            await emitRoomSlotsSnapshot(roomId);
          }

          await emitRoomStats(roomId);
        } else {
          await emitRoomStats(roomId);
        }
        return;
      }

      const room = await AudioRoom.findById(roomId);

      if (
        room &&
        room.hostId &&
        room.hostId.toString() === currentUserId
      ) {
        scheduleHostDisconnectClosure(roomId, currentUserId);
        console.log(`Audio room host disconnected, waiting for reconnect: ${roomId}`);
        return;
      }

      const speaker = room?.speakers?.find(
        s => String(s.userId) === currentUserId
      );

      const oldSlotIndex = speaker?.slotIndex;

      await AudioRoom.findByIdAndUpdate(roomId, {
        $pull: {
          speakers: {
            userId: currentUserId
          },
          audience: currentUserId
        }
      });

      if (oldSlotIndex !== undefined) {
        io.to(roomId).emit("slot_state_changed", {
          slotIndex: oldSlotIndex,
          user: {
            uid: null,
            userId: null,
            username: "",
            avatar: null,
            frameUrl: null,
            isMuted: false
          }
        });
        await emitRoomSlotsSnapshot(roomId);
      }

      if (!roomId || roomId.length !== 24 || !/^[0-9a-fA-F]{24}$/.test(roomId)) {
        return;
      }

    } catch (err) {
      console.log('Critical Error logged inside disconnect pipeline:', err);
    }
  });
});


app.post('/Follow', async (req, res) => {
  const { followerId, followingId } = req.body;

  if (!followerId || !followingId) {
    return res.status(400).json({ message: "Both followerId and followingId are required." });
  }

  if (followerId === followingId) {
    return res.status(400).json({ message: "You cannot follow yourself." });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const existingFollow = await Follow.findOne({
      followerId,
      followingId,
    }).session(session);

    if (existingFollow) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Already following this user." });
    }

    await Follow.create([{ followerId, followingId }], { session });

    await User.findByIdAndUpdate(
      followerId,
      { $inc: { followingCount: 1 } },
      { session }
    );

    await User.findByIdAndUpdate(
      followingId,
      { $inc: { followersCount: 1 } },
      { session }
    );

    await session.commitTransaction();
    await recordRewardActivity(followerId, 'follow_user', { followingId });

    res.status(200).json({ message: "Followed successfully!" });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    session.endSession();
  }
});

app.get('/Friends/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    await clearExpiredStoreItems(userId);

    // 1. Fetch user basic info
    let user = await User.findById(userId).select('-password'); // Exclude password for security

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user = await ensureUserPublicId(user);

    // 2. Aggregate to find mutual friends count
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const result = await Follow.aggregate([
      { $match: { followerId: userObjectId } },
      {
        $lookup: {
          from: 'follows',
          let: { followingObjectId: '$followingId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$followerId', '$$followingObjectId'] },
                    { $eq: ['$followingId', userObjectId] }
                  ]
                }
              }
            }
          ],
          as: 'isMutual'
        }
      },
      { $match: { 'isMutual.0': { $exists: true } } },
      { $count: 'friendCount' }
    ]);

    const friendCount = result.length > 0 ? result[0].friendCount : 0;

    // 3. Return the combined data
    res.status(200).json({
      ...user._doc,
      friends: friendCount // This matches your profile UI needs
    });

  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});



// --- HTTP ENDPOINTS ---
app.post('/create-video', async (req, res) => {
  try {
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    const { hostId, title, numericUid, name, profilePic } = req.body;

    if (!hostId) return res.status(400).json({ success: false, error: 'Host identifier missing' });
    if (!numericUid) return res.status(400).json({ success: false, error: 'Numeric UID missing for token generation' });
    if (!(await canCreateLiveRoom(hostId))) {
      return res.status(403).json({ success: false, error: 'Login is required to create live rooms.' });
    }

    const uniqueChannelName = `glix_${hostId}_${Date.now().toString().slice(-4)}`;

    const initialSlots = [
      {
        id: 1,
        locked: false,
        userId: hostId,
        uid: parseInt(numericUid, 10),
        username: name || 'Main Host',
        avatar: profilePic || null,
        isMe: false,
        isMuted: false,
        cameraOn: true
      },
      { id: 2, locked: false, userId: null, uid: null, username: 'Co-Host 1', avatar: null, isMe: false, isMuted: false, cameraOn: false },
      { id: 3, locked: false, userId: null, uid: null, username: 'Co-Host 2', avatar: null, isMe: false, isMuted: false, cameraOn: false },
    ];

    const newRoom = new Room({
      channelName: uniqueChannelName,
      hostId,
      title: title || "Glix Live Room",
      isLive: true,
      slots: initialSlots
    });

    await newRoom.save();

    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      uniqueChannelName,
      parseInt(numericUid, 10),
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    await recordRewardActivity(hostId, 'create_video_room', { roomId: uniqueChannelName });

    return res.status(200).json({
      success: true,
      room: {
        hostId: newRoom.hostId,
        _id: uniqueChannelName
      },
      channelName: uniqueChannelName,
      agoraToken: token,
      appId: appId
    });

  } catch (error) {
    console.error("Database save crash logs:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/gift-history/room/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const roomMatchValues = [roomId];

    if (mongoose.Types.ObjectId.isValid(roomId)) {
      roomMatchValues.push(new mongoose.Types.ObjectId(roomId));
    }

    const [summaryResult, receiverRows] = await Promise.all([
      GiftTransaction.aggregate([
        {
          $match: {
            roomId: { $in: roomMatchValues }
          }
        },
        {
          $group: {
            _id: "$roomId",
            totalCoins: { $sum: "$totalCost" },
            totalGifts: { $sum: "$quantity" },
            totalTransactions: { $sum: 1 }
          }
        }
      ]),
      GiftTransaction.aggregate([
        {
          $match: {
            roomId: { $in: roomMatchValues }
          }
        },
        {
          $group: {
            _id: "$receiverId",
            totalCoins: { $sum: "$totalCost" },
            totalGifts: { $sum: "$quantity" },
            totalTransactions: { $sum: 1 }
          }
        }
      ])
    ]);

    const receiverTotals = receiverRows.reduce((totals, row) => {
      if (row?._id) totals[row._id.toString()] = row.totalCoins || 0;
      return totals;
    }, {});

    res.status(200).json({
      success: true,
      data: {
        ...(summaryResult[0] || {
          totalCoins: 0,
          totalGifts: 0,
          totalTransactions: 0
        }),
        receiverTotals
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});
app.get('/gift-history/host/:hostId', async (req, res) => {
  try {
    const { hostId } = req.params;

    const result = await GiftTransaction.aggregate([
      {
        $match: {
          receiverId: new mongoose.Types.ObjectId(hostId)
        }
      },
      {
        $group: {
          _id: "$receiverId",
          totalCoins: { $sum: "$totalCost" },
          totalGifts: { $sum: "$quantity" },
          totalTransactions: { $sum: 1 }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: result[0] || {
        totalCoins: 0,
        totalGifts: 0,
        totalTransactions: 0
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post('/create', async (req, res) => {
  try {
    const { title, hostId, numericUid, micSeatCount, micLayoutType } = req.body;
    if (!hostId) return res.status(400).json({ success: false, error: 'Host identifier missing' });
    if (!(await canCreateLiveRoom(hostId))) {
      return res.status(403).json({ success: false, error: 'Login is required to create live rooms.' });
    }
    const sanitizedUid = parseInt(numericUid, 10) || 0;

    const newRoom = new AudioRoom({
      title: title || "Live Audio Room",
      hostId,
      isLive: true,
      micSeatCount: normalizeAudioMicSeatCount(micSeatCount),
      micLayoutType: normalizeAudioLayoutType(micLayoutType),
      speakers: [{ userId: hostId, isMuted: false, slotIndex: 0, numericUid: sanitizedUid }],
      audience: []
    });
    await newRoom.save();

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const channelName = newRoom._id.toString();
    const token = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channelName, sanitizedUid, RtcRole.PUBLISHER, privilegeExpiredTs);

    await recordRewardActivity(hostId, 'create_audio_room', { roomId: channelName });

    return res.status(201).json({
      success: true,
      room: newRoom,
      agoraToken: token,
      channelName: channelName,
      appId: appId
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/join', async (req, res) => {
  try {
    const { roomId, userId, numericUid } = req.body;
    if (!roomId || !userId || !numericUid) return res.status(400).json({ error: "Missing required fields" });



    const sanitizedUid = parseInt(numericUid, 10) || 0;
    const stringRoomId = roomId.toString();
    const isVideoRoom = stringRoomId.startsWith('glix_');

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    let roomObj = null;
    let userRole = RtcRole.SUBSCRIBER; // Default role for audio rooms

    if (isVideoRoom) {
      roomObj = await Room.findOne({ channelName: stringRoomId });
      if (!roomObj) return res.status(404).json({ error: "Video room not found" });
      if (roomObj.isLive === false) return res.status(400).json({ error: "This room has already ended" });
    } else {
      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return res.status(400).json({ error: "Invalid Room ID format" });
      roomObj = await AudioRoom.findById(stringRoomId);
      if (!roomObj) return res.status(404).json({ error: "Audio room not found" });
      if (!roomObj.isLive) return res.status(400).json({ error: "This room has already ended" });

      await AudioRoom.findByIdAndUpdate(roomId, {
        $pull: {
          speakers: { userId }
        }
      });

      roomObj = await AudioRoom.findById(roomId);

      const currentSpeakers = Array.isArray(roomObj.speakers) ? roomObj.speakers : [];
      const currentAudience = Array.isArray(roomObj.audience) ? roomObj.audience : [];
      const validSpeakers = currentSpeakers.filter(s => s && s.userId);
      const validAudience = currentAudience.filter(Boolean);
      if (validSpeakers.length !== currentSpeakers.length || validAudience.length !== currentAudience.length) {
        roomObj.speakers = validSpeakers;
        roomObj.audience = validAudience;
        await roomObj.save();
      }

      // Check if user is already a speaker
      const isAlreadySpeaker = validSpeakers.some(s => String(s.userId) === String(userId));
      const isAlreadyAudience = validAudience.some(id => String(id) === String(userId));

      if (isAlreadySpeaker) {
        // User is a speaker - give them PUBLISHER role so they can transmit audio
        userRole = RtcRole.PUBLISHER;
      } else if (!isAlreadyAudience) {
        // New audience member - add them
        roomObj.audience.push(userId);
        await roomObj.save();
      }
    }

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      stringRoomId,
      sanitizedUid,
      userRole,
      privilegeExpiredTs
    );

    await recordRewardActivity(userId, isVideoRoom ? 'join_video_room' : 'join_audio_room', { roomId: stringRoomId });

    return res.status(200).json({
      success: true,
      room: {
        hostId: roomObj.hostId,
        _id: isVideoRoom
          ? roomObj.channelName
          : roomObj._id.toString()
      },
      agoraToken: token,
      channelName: stringRoomId,
      appId: appId,
      userRole: userRole === RtcRole.PUBLISHER ? 'speaker' : 'audience'
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// NEW: Regenerate token when user is promoted to speaker
app.post('/regenerate-token', async (req, res) => {
  try {
    const { roomId, userId, numericUid, isBecomingSpeaker } = req.body;
    if (!roomId || !userId || !numericUid) return res.status(400).json({ error: "Missing required fields" });

    const sanitizedUid = parseInt(numericUid, 10) || 0;
    const stringRoomId = roomId.toString();

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    // Determine role based on whether user is becoming a speaker
    const userRole = isBecomingSpeaker ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      stringRoomId,
      sanitizedUid,
      userRole,
      privilegeExpiredTs
    );

    return res.status(200).json({
      success: true,
      agoraToken: token,
      userRole: isBecomingSpeaker ? 'speaker' : 'audience'
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/rooms/end', async (req, res) => {
  try {
    const { roomId, hostId } = req.body;
    if (!roomId || !hostId) return res.status(400).json({ success: false, error: "Missing properties context" });

    const stringRoomId = roomId.toString();
    const pending = pendingHostDisconnects.get(stringRoomId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingHostDisconnects.delete(stringRoomId);
    }

    if (stringRoomId.startsWith('glix_')) {
      const room = await Room.findOne({ channelName: stringRoomId });

      if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
      if (
        !room.hostId ||
        !hostId ||
        room.hostId.toString() !== String(hostId))
        return res.status(403).json({ success: false, error: 'Unauthorized' });

      io.to(stringRoomId).emit('room_closing', { message: 'The host has ended the video live stream.' });
      room.isLive = false;
      await room.save();
      await new Promise(resolve => setTimeout(resolve, 500));

    } else {
      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return res.status(400).json({ error: "Malformed ID structure" });

      const room = await AudioRoom.findById(stringRoomId);
      if (room && room.hostId && room.hostId.toString() === hostId) {
        room.isLive = false;
        room.speakers = [];
        room.audience = [];
        await room.save();
        audioRoomControllers.delete(stringRoomId);

        io.to(stringRoomId).emit('audio_room_ended', {
          message: "The live audio room has been closed by the host."
        });
      }
    }
    return res.status(200).json({ success: true, message: "Room closed cleanly." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/rooms/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(roomId)) return res.status(400).json({ error: "Malformed Object reference ID" });

    const room = await AudioRoom.findById(roomId)
      .populate('hostId', 'name profilePic username')
      .populate('speakers.userId', 'name profilePic username')
      .populate('audience', 'name profilePic username');

    if (!room) return res.status(404).json({ error: "Room not found" });
    return res.status(200).json({ success: true, room });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/video-rooms', async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [{ isLive: true }, { isLive: { $exists: false } }]
    }).sort({ createdAt: -1 });
    const liveRooms = rooms.filter(room =>
      room.isLive === true || io.sockets.adapter.rooms.get(room.channelName)?.size > 0
    );
    return res.status(200).json({ success: true, rooms: liveRooms });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/rooms', async (req, res) => {
  try {
    const liveRooms = await AudioRoom.find({ isLive: true }).populate('hostId', 'name profilePic username').sort({ createdAt: -1 });
    const formattedRooms = liveRooms.map(room => ({
      id: room._id,
      title: room.title,
      host: room.hostId,
      speakerCount: room.speakers.length,
      audienceCount: room.audience.length,
      micSeatCount: normalizeAudioMicSeatCount(room.micSeatCount),
      micLayoutType: normalizeAudioLayoutType(room.micLayoutType),
      createdAt: room.createdAt
    }));
    return res.status(200).json({ success: true, rooms: formattedRooms });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/host/register', async (req, res) => {
  try {
    const {
      userId,
      fullName,
      gender,
      hostType,
      agencySelection,
      agencyCode,
      phoneCountryCode,
      phoneNumber,
      acceptedTerms,
      verificationImages = {}
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Valid user is required' });
    }

    const cleanName = String(fullName || '').trim();
    const cleanPhone = String(phoneNumber || '').trim();
    const cleanCountryCode = String(phoneCountryCode || '').trim() || '+92';
    const cleanAgencyCode = String(agencyCode || '').trim().toUpperCase();
    const cleanGender = ['Male', 'Female', 'Other'].includes(gender) ? gender : '';
    const cleanHostType = ['Video Live Host', 'Voice Live Host'].includes(hostType) ? hostType : '';
    const cleanAgencySelection = ['Official', 'Other Agency'].includes(agencySelection) ? agencySelection : '';

    if (!cleanName) return res.status(400).json({ message: 'Full real name is required' });
    if (!cleanGender) return res.status(400).json({ message: 'Gender is required' });
    if (!cleanHostType) return res.status(400).json({ message: 'Host type is required' });
    if (!cleanAgencySelection) return res.status(400).json({ message: 'Agency selection is required' });
    if (!cleanPhone) return res.status(400).json({ message: 'Phone number is required' });
    if (!acceptedTerms) return res.status(400).json({ message: 'Terms acceptance is required' });
    if (!verificationImages.selfiePhoto) return res.status(400).json({ message: 'Selfie verification photo is required' });

    let agencyId = null;
    if (cleanAgencySelection === 'Other Agency' && cleanAgencyCode) {
      const agencyUser = await User.findOne({ role: 'agency', agencyCode: cleanAgencyCode }).select('_id').lean();
      agencyId = agencyUser?._id || null;
    }

    const existingUser = await User.findById(userId).select('role').lean();
    if (!existingUser) return res.status(404).json({ message: 'User not found' });

    const [selfiePhotoUrl] = await Promise.all([
      uploadHostVerificationImage({ userId, key: 'selfie-photo', image: verificationImages.selfiePhoto })
    ]);

    const submittedAgencyCode = cleanAgencyCode || (cleanAgencySelection === 'Official' ? 'OFFICIAL' : '');
    const preservedRole = HOST_REVIEWER_ROLES.includes(existingUser.role) || existingUser.role === 'agency'
      ? existingUser.role
      : 'user';
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          name: cleanName,
          role: preservedRole,
          hostStatus: 'pending',
          hostRejectionReason: '',
          agencyId,
          agencyCode: submittedAgencyCode,
          hostRegistration: {
            fullName: cleanName,
            gender: cleanGender,
            hostType: cleanHostType,
            agencySelection: cleanAgencySelection,
            agencyCode: submittedAgencyCode,
            phoneCountryCode: cleanCountryCode,
            phoneNumber: cleanPhone,
            profilePhotoUrl: '',
            idFrontUrl: '',
            idBackUrl: '',
            selfiePhotoUrl,
            status: 'pending',
            rejectionReason: '',
            reviewedBy: null,
            reviewedAt: null,
            acceptedTerms: true,
            registeredAt: new Date()
          }
        }
      },
      { new: true }
    ).select(PUBLIC_USER_FIELDS);

    if (!user) return res.status(404).json({ message: 'User not found' });

    return res.status(200).json({
      message: 'Host registration submitted for verification',
      user
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get('/host/requests', async (req, res) => {
  try {
    const reviewer = await requireAuthUser(req, res);
    if (!reviewer) return;
    if (!(await canReviewHostRequests(reviewer._id))) {
      return res.status(403).json({ success: false, message: 'Only admin or manager can review host requests' });
    }

    const requests = await User.find({ hostStatus: 'pending' })
      .select('name email profilePic glixId role agencyId agencyCode hostStatus hostRegistration createdAt')
      .sort({ 'hostRegistration.registeredAt': -1 })
      .lean();

    return res.status(200).json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/host/requests/:userId', async (req, res) => {
  try {
    const reviewer = await requireAuthUser(req, res);
    if (!reviewer) return;
    const { status, reason = '' } = req.body;
    const targetUserId = req.params.userId;

    if (!(await canReviewHostRequests(reviewer._id))) {
      return res.status(403).json({ success: false, message: 'Only admin or manager can review host requests' });
    }
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ success: false, message: 'Valid host request user is required' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Review status must be approved or rejected' });
    }

    const update = {
      hostStatus: status,
      hostRejectionReason: status === 'rejected' ? String(reason || '').trim() : '',
      'hostRegistration.status': status,
      'hostRegistration.rejectionReason': status === 'rejected' ? String(reason || '').trim() : '',
      'hostRegistration.reviewedBy': reviewer._id,
      'hostRegistration.reviewedAt': new Date()
    };

    if (status === 'approved') {
      update.role = 'host';
    } else {
      update.role = 'user';
    }

    const user = await User.findByIdAndUpdate(targetUserId, { $set: update }, { new: true }).select(PUBLIC_USER_FIELDS);
    if (!user) return res.status(404).json({ success: false, message: 'Host request not found' });

    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/agency/register', async (req, res) => {
  try {
    const authUser = await requireAuthUser(req, res);
    if (!authUser) return;

    const {
      agencyName,
      ownerName,
      agencyCode,
      phoneCountryCode,
      phoneNumber,
      city,
      expectedHosts,
      experience,
      acceptedTerms,
      verificationImages = {}
    } = req.body;

    const userId = authUser._id;
    const cleanAgencyName = String(agencyName || '').trim();
    const cleanOwnerName = String(ownerName || '').trim();
    const cleanCode = normalizeAgencyCode(agencyCode);
    const cleanPhone = String(phoneNumber || '').trim();
    const cleanCountryCode = String(phoneCountryCode || '').trim() || '+92';
    const cleanCity = String(city || '').trim();
    const hostCount = Math.max(0, Math.floor(Number(expectedHosts) || 0));
    const cleanExperience = String(experience || '').trim().slice(0, 500);

    if (!cleanAgencyName) return res.status(400).json({ success: false, message: 'Agency name is required' });
    if (!cleanOwnerName) return res.status(400).json({ success: false, message: 'Owner name is required' });
    if (!cleanCode) return res.status(400).json({ success: false, message: 'Agency code is required' });
    if (!cleanPhone) return res.status(400).json({ success: false, message: 'Phone number is required' });
    if (!cleanCity) return res.status(400).json({ success: false, message: 'City is required' });
    if (!acceptedTerms) return res.status(400).json({ success: false, message: 'Terms acceptance is required' });
    if (!verificationImages.profilePhoto) return res.status(400).json({ success: false, message: 'Profile photo is required' });
    if (!verificationImages.idFront) return res.status(400).json({ success: false, message: 'ID front photo is required' });
    if (!verificationImages.idBack) return res.status(400).json({ success: false, message: 'ID back photo is required' });
    if (!verificationImages.selfiePhoto) return res.status(400).json({ success: false, message: 'Selfie verification photo is required' });

    const existingCode = await User.findOne({ agencyCode: cleanCode, _id: { $ne: userId } }).select('_id').lean();
    if (existingCode) return res.status(400).json({ success: false, message: 'Agency code is already used' });

    const [profilePhotoUrl, idFrontUrl, idBackUrl, selfiePhotoUrl] = await Promise.all([
      uploadHostVerificationImage({ userId, key: 'agency-profile-photo', image: verificationImages.profilePhoto }),
      uploadHostVerificationImage({ userId, key: 'agency-id-front', image: verificationImages.idFront }),
      uploadHostVerificationImage({ userId, key: 'agency-id-back', image: verificationImages.idBack }),
      uploadHostVerificationImage({ userId, key: 'agency-selfie-photo', image: verificationImages.selfiePhoto })
    ]);

    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          agencyStatus: 'pending',
          agencyRejectionReason: '',
          agencyRegistration: {
            agencyName: cleanAgencyName,
            ownerName: cleanOwnerName,
            requestedAgencyCode: cleanCode,
            phoneCountryCode: cleanCountryCode,
            phoneNumber: cleanPhone,
            city: cleanCity,
            expectedHosts: hostCount,
            experience: cleanExperience,
            profilePhotoUrl,
            idFrontUrl,
            idBackUrl,
            selfiePhotoUrl,
            status: 'pending',
            rejectionReason: '',
            reviewedBy: null,
            reviewedAt: null,
            acceptedTerms: true,
            registeredAt: new Date()
          }
        }
      },
      { new: true }
    ).select(PUBLIC_USER_FIELDS);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, message: 'Agency registration submitted for review', user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/agency/requests', async (req, res) => {
  try {
    const admin = await requireAuthUser(req, res);
    if (!admin) return;
    if (!(await canUseAdminPanel(admin._id))) {
      return res.status(403).json({ success: false, message: 'Only admin can review agency requests' });
    }

    const requests = await User.find({ agencyStatus: 'pending' })
      .select('name email profilePic glixId role agencyStatus agencyRegistration createdAt')
      .sort({ 'agencyRegistration.registeredAt': -1 })
      .lean();

    return res.status(200).json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/agency/requests/:userId', async (req, res) => {
  try {
    const admin = await requireAuthUser(req, res);
    if (!admin) return;
    const targetUserId = req.params.userId;
    const { status, reason = '' } = req.body;

    if (!(await canUseAdminPanel(admin._id))) {
      return res.status(403).json({ success: false, message: 'Only admin can review agency requests' });
    }
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ success: false, message: 'Valid agency request user is required' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Review status must be approved or rejected' });
    }

    const applicant = await User.findById(targetUserId).select('agencyRegistration agencyStatus glixId role');
    if (!applicant || applicant.agencyStatus !== 'pending') {
      return res.status(404).json({ success: false, message: 'Agency request not found' });
    }

    const requestedCode = normalizeAgencyCode(applicant.agencyRegistration?.requestedAgencyCode) || normalizeAgencyCode(applicant.glixId) || `AG${Date.now().toString().slice(-6)}`;
    const existingCode = await User.findOne({ agencyCode: requestedCode, _id: { $ne: targetUserId } }).select('_id').lean();
    if (status === 'approved' && existingCode) {
      return res.status(400).json({ success: false, message: 'Requested agency code is already used' });
    }

    const update = {
      agencyStatus: status,
      agencyRejectionReason: status === 'rejected' ? String(reason || '').trim() : '',
      'agencyRegistration.status': status,
      'agencyRegistration.rejectionReason': status === 'rejected' ? String(reason || '').trim() : '',
      'agencyRegistration.reviewedBy': admin._id,
      'agencyRegistration.reviewedAt': new Date()
    };

    if (status === 'approved') {
      update.role = 'agency';
      update.agencyCode = requestedCode;
    }

    const user = await User.findByIdAndUpdate(targetUserId, { $set: update }, { new: true }).select(PUBLIC_USER_FIELDS);
    if (!user) return res.status(404).json({ success: false, message: 'Agency request not found' });

    const agency = status === 'approved' ? await buildAgencySummary(user.toObject()) : null;
    return res.status(200).json({ success: true, user, agency });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/agencies', async (req, res) => {
  try {
    const admin = await requireAuthUser(req, res);
    if (!admin) return;
    if (!(await canUseAdminPanel(admin._id))) {
      return res.status(403).json({ success: false, message: 'Only admin can access agencies' });
    }

    const agencies = await User.find({ role: 'agency' })
      .select('name email profilePic glixId agencyCode commissionBalance totalHostCoins createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const rows = await Promise.all(agencies.map(buildAgencySummary));
    return res.status(200).json({ success: true, agencies: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/agencies', async (req, res) => {
  try {
    const admin = await requireAuthUser(req, res);
    if (!admin) return;
    const { identifier, agencyCode } = req.body;
    if (!(await canUseAdminPanel(admin._id))) {
      return res.status(403).json({ success: false, message: 'Only admin can assign agencies' });
    }

    const cleanIdentifier = String(identifier || '').trim();
    if (!cleanIdentifier) return res.status(400).json({ success: false, message: 'Email or Glix ID is required' });

    const query = cleanIdentifier.includes('@')
      ? { email: cleanIdentifier.toLowerCase() }
      : { glixId: cleanIdentifier };

    const target = await User.findOne(query);
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (target.role === 'admin') return res.status(400).json({ success: false, message: 'Admin account cannot be converted to agency' });

    const cleanCode = normalizeAgencyCode(agencyCode) || normalizeAgencyCode(target.glixId) || `AG${Date.now().toString().slice(-6)}`;
    const existingCode = await User.findOne({ agencyCode: cleanCode, _id: { $ne: target._id } }).select('_id').lean();
    if (existingCode) return res.status(400).json({ success: false, message: 'Agency code is already used' });

    target.role = 'agency';
    target.agencyCode = cleanCode;
    await target.save();

    const agency = await buildAgencySummary(target.toObject());
    return res.status(200).json({ success: true, agency });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/agencies/:agencyId', async (req, res) => {
  try {
    const admin = await requireAuthUser(req, res);
    if (!admin) return;
    const { agencyCode } = req.body;
    const { agencyId } = req.params;
    if (!(await canUseAdminPanel(admin._id))) {
      return res.status(403).json({ success: false, message: 'Only admin can update agencies' });
    }
    if (!mongoose.Types.ObjectId.isValid(agencyId)) return res.status(400).json({ success: false, message: 'Invalid agency id' });

    const cleanCode = normalizeAgencyCode(agencyCode);
    if (!cleanCode) return res.status(400).json({ success: false, message: 'Agency code is required' });

    const existingCode = await User.findOne({ agencyCode: cleanCode, _id: { $ne: agencyId } }).select('_id').lean();
    if (existingCode) return res.status(400).json({ success: false, message: 'Agency code is already used' });

    const updated = await User.findOneAndUpdate(
      { _id: agencyId, role: 'agency' },
      { $set: { agencyCode: cleanCode } },
      { new: true }
    ).select('name email profilePic glixId agencyCode commissionBalance totalHostCoins createdAt');

    if (!updated) return res.status(404).json({ success: false, message: 'Agency not found' });
    const agency = await buildAgencySummary(updated.toObject());
    return res.status(200).json({ success: true, agency });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/agencies/:agencyId/hosts', async (req, res) => {
  try {
    const admin = await requireAuthUser(req, res);
    if (!admin) return;
    const { agencyId } = req.params;
    if (!(await canUseAdminPanel(admin._id))) {
      return res.status(403).json({ success: false, message: 'Only admin can view agency hosts' });
    }
    if (!mongoose.Types.ObjectId.isValid(agencyId)) return res.status(400).json({ success: false, message: 'Invalid agency id' });

    const hosts = await User.find({ agencyId })
      .select('name email profilePic glixId hostStatus daimon totalHostCoins createdAt')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, hosts });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/withdrawals', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const authUser = await requireAuthUser(req, res);
    if (!authUser) {
      await session.abortTransaction();
      return;
    }
    const userId = authUser._id;
    const { amount, method, accountTitle, accountNumber, note = '' } = req.body;
    const numericAmount = Math.floor(Number(amount));

    if (!Number.isFinite(numericAmount) || numericAmount < MIN_WITHDRAW_AMOUNT) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Minimum withdrawal is ${MIN_WITHDRAW_AMOUNT}` });
    }
    if (!WITHDRAW_METHODS.includes(method)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Select a valid withdrawal method' });
    }

    const cleanAccountTitle = sanitizeWithdrawalText(accountTitle, 70);
    const cleanAccountNumber = sanitizeWithdrawalText(accountNumber, 50);
    if (!cleanAccountTitle || !cleanAccountNumber) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Account title and number are required' });
    }

    const user = await User.findById(userId).select('role hostStatus daimon chang commissionBalance revenueBalance').session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const source = getWithdrawSourceForRole(user.role);
    if (!source) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Your account is not eligible for withdrawals' });
    }
    if (user.role === 'host' && user.hostStatus !== 'approved') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Host must be approved before withdrawal' });
    }

    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, [source]: { $gte: numericAmount } },
      { $inc: { [source]: -numericAmount } },
      { new: true, session }
    ).select('daimon chang commissionBalance revenueBalance');

    if (!updatedUser) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Insufficient withdrawable balance' });
    }

    const [withdrawal] = await Withdrawal.create([{
      userId,
      amount: numericAmount,
      source,
      method,
      accountTitle: cleanAccountTitle,
      accountNumber: cleanAccountNumber,
      note: sanitizeWithdrawalText(note, 180),
      status: 'pending'
    }], { session });

    await session.commitTransaction();
    return res.status(201).json({
      success: true,
      message: 'Withdrawal request submitted',
      withdrawal,
      wallet: buildWalletSnapshot(updatedUser)
    });
  } catch (error) {
    await session.abortTransaction();
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
});

app.get('/withdrawals/my/:userId', async (req, res) => {
  try {
    const authUser = await requireAuthUser(req, res);
    if (!authUser) return;
    const userId = authUser._id;

    const withdrawals = await Withdrawal.find({ userId })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    return res.status(200).json({ success: true, withdrawals });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/withdrawals', async (req, res) => {
  try {
    const reviewer = await requireAuthUser(req, res);
    if (!reviewer) return;
    const status = req.query.status || 'pending';

    if (!(await canReviewHostRequests(reviewer._id))) {
      return res.status(403).json({ success: false, message: 'Only admin or manager can review withdrawals' });
    }

    const filter = ['pending', 'approved', 'rejected'].includes(status) ? { status } : {};
    const withdrawals = await Withdrawal.find(filter)
      .populate('userId', 'name profilePic glixId role')
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    return res.status(200).json({ success: true, withdrawals });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/withdrawals/:withdrawalId', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const reviewer = await requireAuthUser(req, res);
    if (!reviewer) {
      await session.abortTransaction();
      return;
    }
    const { withdrawalId } = req.params;
    const { status, reviewNote = '', transactionRef = '' } = req.body;

    if (!mongoose.Types.ObjectId.isValid(withdrawalId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid withdrawal id' });
    }
    if (!(await canReviewHostRequests(reviewer._id))) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Only admin or manager can review withdrawals' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Review status must be approved or rejected' });
    }

    const withdrawal = await Withdrawal.findById(withdrawalId).session(session);
    if (!withdrawal) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    }
    if (withdrawal.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Withdrawal is already reviewed' });
    }

    withdrawal.status = status;
    withdrawal.reviewerId = reviewer._id;
    withdrawal.reviewNote = sanitizeWithdrawalText(reviewNote, 180);
    withdrawal.transactionRef = status === 'approved' ? sanitizeWithdrawalText(transactionRef, 80) : '';
    withdrawal.reviewedAt = new Date();

    if (status === 'rejected') {
      await User.findByIdAndUpdate(
        withdrawal.userId,
        { $inc: { [withdrawal.source]: withdrawal.amount } },
        { session }
      );
    }

    await withdrawal.save({ session });
    await session.commitTransaction();

    const reviewed = await Withdrawal.findById(withdrawal._id)
      .populate('userId', 'name profilePic glixId role')
      .lean();

    return res.status(200).json({ success: true, withdrawal: reviewed });
  } catch (error) {
    await session.abortTransaction();
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
});

app.post('/register', async (req, res) => {
  try {
    const { name, email, password, profilePic, googleId } = req.body;
    const normalizedEmail = email?.toLowerCase();
    if (!normalizedEmail) return res.status(400).json({ message: 'Email is required' });

    let user = await User.findOne({ email: normalizedEmail });
    if (user) {
      if (!user.glixId) {
        user = await ensureUserPublicId(user);
      }
      const token = await signAuthToken(user);
      return res.status(200).json({
        message: 'Login successful!',
        token,
        user: { id: user._id, name: user.name, email: user.email, glixId: user.glixId }
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = password ? await bcrypt.hash(password, salt) : null;
    const newUser = new User({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      profilePic: profilePic || '',
      googleId: googleId || null,
      glixId: await createUniqueUserPublicId()
    });
    await newUser.save();
    const token = await signAuthToken(newUser);
    return res.status(201).json({
      message: 'Registered!',
      token,
      user: { id: newUser._id, name: newUser.name, email: newUser.email, glixId: newUser.glixId }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = email?.toLowerCase().trim();

    if (!normalizedEmail) return res.status(400).json({ message: 'Email is required' });
    if (!password) return res.status(400).json({ message: 'Password is required' });

    let user = await User.findOne({ email: normalizedEmail });
    if (!user || !user.password) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (!user.glixId) {
      user = await ensureUserPublicId(user);
    }

    user.lastLogin = new Date();
    await user.save();

    const token = await signAuthToken(user);
    return res.status(200).json({
      success: true,
      message: 'Login successful!',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        glixId: user.glixId,
        profilePic: user.profilePic || '',
        role: user.role || 'user',
        hostStatus: user.hostStatus || 'none'
      }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});



const getRankPeriodMatch = (period) => {
  const rangeInDays = { day: 1, week: 7, month: 30 }[period];
  if (!rangeInDays) return null;

  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - rangeInDays);

  return { createdAt: { $gte: start, $lt: now } };
};

const getUserRankRows = async ({ sortField, limit }) => {
  const users = await User.find({})
    .select(`name profilePic glixId ${sortField}`)
    .sort({ [sortField]: -1, createdAt: 1 })
    .limit(limit)
    .lean();

  return users.map((user, index) => ({
    rank: index + 1,
    userId: user._id,
    name: user.name || 'User',
    profilePic: user.profilePic || '',
    glixId: user.glixId || '',
    score: user[sortField] || 0
  }));
};

const getGiftRankRows = async ({ groupField, limit, period }) => {
  const periodMatch = getRankPeriodMatch(period);
  const pipeline = [];
  if (periodMatch) pipeline.push({ $match: periodMatch });

  pipeline.push(
    {
      $group: {
        _id: `$${groupField}`,
        score: { $sum: '$totalCost' },
        totalGifts: { $sum: '$quantity' },
        totalTransactions: { $sum: 1 }
      }
    },
    { $sort: { score: -1, totalTransactions: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user'
      }
    },
    { $unwind: '$user' },
    {
      $project: {
        _id: 0,
        userId: '$_id',
        name: { $ifNull: ['$user.name', 'User'] },
        profilePic: { $ifNull: ['$user.profilePic', ''] },
        glixId: { $ifNull: ['$user.glixId', ''] },
        score: { $ifNull: ['$score', 0] },
        totalGifts: { $ifNull: ['$totalGifts', 0] },
        totalTransactions: { $ifNull: ['$totalTransactions', 0] }
      }
    }
  );

  const rows = await GiftTransaction.aggregate(pipeline);
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
};

const getActivityRankRows = async ({ types, limit, period }) => {
  const periodMatch = getRankPeriodMatch(period);
  const match = { type: { $in: types } };
  if (periodMatch) Object.assign(match, periodMatch);

  const rows = await RewardActivity.aggregate([
    { $match: match },
    { $group: { _id: '$userId', score: { $sum: 1 } } },
    { $sort: { score: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user'
      }
    },
    { $unwind: '$user' },
    {
      $project: {
        _id: 0,
        userId: '$_id',
        name: { $ifNull: ['$user.name', 'User'] },
        profilePic: { $ifNull: ['$user.profilePic', ''] },
        glixId: { $ifNull: ['$user.glixId', ''] },
        score: { $ifNull: ['$score', 0] }
      }
    }
  ]);

  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
};


app.get('/store/items', async (req, res) => {
  try {
    await ensureDefaultStoreItems();
    const { category } = req.query;
    const filter = { isActive: true };
    if (category && category !== 'All') filter.category = category;

    const items = await StoreItem.find(filter).sort({ section: 1, sortOrder: 1, createdAt: -1 }).lean();
    return res.status(200).json({ success: true, items });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/store/wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const wallet = await getStoreWallet(userId);
    if (!wallet) return res.status(404).json({ success: false, message: 'User not found' });

    return res.status(200).json({ success: true, wallet });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/store/my-items/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    await clearExpiredStoreItems(userId);

    const now = new Date();
    const items = await UserStoreItem.find({
      userId,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    }).populate('itemId').lean();

    return res.status(200).json({ success: true, items });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/store/purchase', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId, itemId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid purchase request' });
    }

    const item = await StoreItem.findById(itemId).session(session);
    if (!item || !item.isActive) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Store item not found' });
    }

    const existing = await UserStoreItem.findOne({ userId, itemKey: item.itemKey }).session(session);
    if (existing && (!existing.expiresAt || existing.expiresAt > new Date())) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Item already owned' });
    }

    const user = await User.findOneAndUpdate(
      { _id: userId, chang: { $gte: item.price } },
      { $inc: { chang: -item.price } },
      { new: true, session }
    );

    if (!user) throw new Error('Insufficient coins');

    const expiresAt = getStoreExpiry(item);
    await UserStoreItem.findOneAndUpdate(
      { userId, itemKey: item.itemKey },
      {
        $set: {
          userId,
          itemId: item._id,
          itemKey: item.itemKey,
          type: item.type,
          startedAt: new Date(),
          expiresAt,
          isEquipped: false
        }
      },
      { upsert: true, new: true, session }
    );

    await session.commitTransaction();
    const wallet = await getStoreWallet(userId);
    return res.status(200).json({ success: true, message: 'Purchase successful', wallet });
  } catch (error) {
    await session.abortTransaction();
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
});

app.post('/store/equip', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId, itemId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid equip request' });
    }

    const owned = await UserStoreItem.findOne({ userId, itemId }).populate('itemId').session(session);
    if (!owned || (owned.expiresAt && owned.expiresAt <= new Date())) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Item is not owned or has expired' });
    }

    const item = owned.itemId;
    const equipUpdate = getStoreEquipUpdate(item);
    if (!equipUpdate) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'This item cannot be equipped yet' });
    }

    await UserStoreItem.updateMany({ userId, type: owned.type }, { $set: { isEquipped: false } }, { session });
    owned.isEquipped = true;
    await owned.save({ session });

    await User.findByIdAndUpdate(userId, { $set: equipUpdate }, { session });

    await session.commitTransaction();
    const wallet = await getStoreWallet(userId);
    return res.status(200).json({ success: true, message: 'Item equipped', wallet });
  } catch (error) {
    await session.abortTransaction();
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
});

app.get('/rank/:type', async (req, res) => {
  try {
    const type = (req.params.type || 'host').toLowerCase();
    const period = (req.query.period || 'day').toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const rankConfig = {
      host: { title: 'Top hosts by gifts received', unit: 'Diamonds' },
      rich: { title: 'Rich users by diamond balance', unit: 'Diamonds' },
      gift: { title: 'Top gifters by gifts sent', unit: 'Diamonds' },
      video: { title: 'Top video room activity', unit: 'Lives' }
    };

    if (!rankConfig[type]) {
      return res.status(404).json({ success: false, message: 'Rank type not found' });
    }

    let ranks = [];
    let title = rankConfig[type].title;

    if (period === 'rocket_host') {
      ranks = await getActivityRankRows({
        types: ['create_audio_room', 'create_video_room'],
        limit,
        period: null
      });
      title = 'Rocket host ranking by live rooms created';
    } else {
      if (type === 'host') ranks = await getGiftRankRows({ groupField: 'receiverId', limit, period });
      if (type === 'rich') ranks = await getUserRankRows({ sortField: 'daimon', limit });
      if (type === 'gift') ranks = await getGiftRankRows({ groupField: 'senderId', limit, period });
      if (type === 'video') {
        ranks = await getActivityRankRows({
          types: ['create_video_room', 'join_video_room'],
          limit,
          period
        });
      }
    }

    const totalScore = ranks.reduce((sum, row) => sum + (row.score || 0), 0);

    return res.status(200).json({
      success: true,
      type,
      period,
      ...rankConfig[type],
      title,
      totalScore,
      ranks
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/rewards/:userId', async (req, res) => {
  try {
    const dashboard = await buildRewardDashboard(req.params.userId);
    return res.status(200).json(dashboard);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

app.post('/rewards/claim', async (req, res) => {
  try {
    const { userId, taskKey } = req.body;
    const task = REWARD_TASKS.find(item => item.key === taskKey);
    if (!task) return res.status(404).json({ success: false, message: 'Reward task not found' });
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (!(await canClaimRewards(userId))) {
      return res.status(403).json({ success: false, message: 'Only approved hosts can claim rewards' });
    }

    const now = new Date();
    const { start, end, dayKey } = getRewardDayRange(now);
    const progress = await getRewardProgress(userId, task, start, end);
    if (progress < task.target) {
      return res.status(400).json({ success: false, message: 'Task is not complete yet' });
    }

    const isDailyCheckIn = task.key === 'daily_check_in';
    if (isDailyCheckIn) {
      const dailyCheckInAvailability = await getDailyCheckInAvailability(userId, now);
      if (!dailyCheckInAvailability.canClaim) {
        return res.status(400).json({
          success: false,
          message: 'Daily check-in can be claimed after 24 hours',
          nextClaimAt: dailyCheckInAvailability.nextClaimAt
        });
      }
    }

    const claimKey = isDailyCheckIn ? `${userId}:${task.key}:${now.getTime()}` : `${userId}:${task.key}:${dayKey}`;
    const existingClaim = await RewardClaim.findOne({ claimKey });
    if (existingClaim) {
      return res.status(400).json({ success: false, message: isDailyCheckIn ? 'Daily check-in can be claimed after 24 hours' : 'Reward already claimed today' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await RewardClaim.create([{
        userId,
        taskKey: task.key,
        claimKey,
        rewardType: task.rewardType,
        amount: task.amount
      }], { session });

      await User.findByIdAndUpdate(
        userId,
        { $inc: { [task.rewardType]: task.amount } },
        { session }
      );

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      if (error.code === 11000) {
        return res.status(400).json({ success: false, message: isDailyCheckIn ? 'Daily check-in can be claimed after 24 hours' : 'Reward already claimed today' });
      }
      throw error;
    } finally {
      session.endSession();
    }

    const dashboard = await buildRewardDashboard(userId);
    return res.status(200).json({
      ...dashboard,
      message: `Claimed ${task.amount} ${task.rewardType}`
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

const PUBLIC_USER_FIELDS = 'name email profilePic gender age birthday countryRegion voiceSignature signature albumPhotos glixId googleId createdAt lastLogin followersCount followingCount daimon chang frameUrl entryVideoUrl settings blacklistedUsers role agencyId agencyCode managerPermissions commissionBalance revenueBalance totalHostCoins hostStatus hostRejectionReason hostRegistration agencyStatus agencyRejectionReason agencyRegistration';

const sanitizeUserSettings = (settings = {}) => {
  const allowedMessagesFrom = ['everyone', 'following', 'none'];
  const sanitized = {};

  [
    'floatingPlayer',
    'newMessageNotifications',
    'liveNotifications',
    'giftNotifications',
    'showOnlineStatus',
    'allowRoomInvites',
    'showProfileVisits'
  ].forEach((key) => {
    if (typeof settings[key] === 'boolean') sanitized[key] = settings[key];
  });

  if (allowedMessagesFrom.includes(settings.allowMessagesFrom)) {
    sanitized.allowMessagesFrom = settings.allowMessagesFrom;
  }

  if (typeof settings.language === 'string' && settings.language.trim()) {
    sanitized.language = settings.language.trim().slice(0, 40);
  }

  return sanitized;
};

app.get('/settings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const user = await User.findById(userId)
      .select(`${PUBLIC_USER_FIELDS} password`)
      .populate('blacklistedUsers', 'name profilePic glixId')
      .lean();

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const hasPassword = Boolean(user.password);
    delete user.password;

    return res.status(200).json({
      success: true,
      user,
      settings: user.settings || {},
      blacklistedUsers: user.blacklistedUsers || [],
      security: {
        hasPassword,
        hasGoogle: Boolean(user.googleId),
        level: hasPassword && user.email ? 'Good' : 'Low'
      },
      app: {
        name: 'Glix Live',
        version: process.env.APP_VERSION || '1.0.0'
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/settings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const settings = sanitizeUserSettings(req.body?.settings || req.body || {});
    const update = Object.entries(settings).reduce((acc, [key, value]) => {
      acc[`settings.${key}`] = value;
      return acc;
    }, {});

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: update },
      { new: true }
    ).select(PUBLIC_USER_FIELDS);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, settings: user.settings, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/profile-picture', async (req, res) => {
  try {
    const { userId } = req.params;
    const { image } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (!image?.base64) return res.status(400).json({ success: false, message: 'Profile picture is required' });

    const profilePic = await uploadHostVerificationImage({
      userId,
      key: 'profile-picture',
      image
    });

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { profilePic } },
      { new: true }
    ).select(PUBLIC_USER_FIELDS);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, profilePic, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/profile-name', async (req, res) => {
  try {
    const { userId } = req.params;
    const cleanName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (cleanName.length < 2) return res.status(400).json({ success: false, message: 'Name must be at least 2 characters' });
    if (cleanName.length > 40) return res.status(400).json({ success: false, message: 'Name must be 40 characters or less' });

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { name: cleanName } },
      { new: true }
    ).select(PUBLIC_USER_FIELDS);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, name: user.name, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/profile-info', async (req, res) => {
  try {
    const { userId } = req.params;
    const allowedGenders = ['Male', 'Female', 'Other', ''];

    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const update = {};

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'gender')) {
      const gender = typeof req.body.gender === 'string' ? req.body.gender.trim() : '';
      if (!allowedGenders.includes(gender)) return res.status(400).json({ success: false, message: 'Invalid gender' });
      update.gender = gender;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'birthday')) {
      const birthday = req.body.birthday || '';
      if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
        return res.status(400).json({ success: false, message: 'Birthday must use YYYY-MM-DD format' });
      }
      update.birthday = birthday;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'countryRegion')) {
      update.countryRegion = typeof req.body.countryRegion === 'string' ? req.body.countryRegion.trim().slice(0, 80) : '';
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'voiceSignature')) {
      update.voiceSignature = typeof req.body.voiceSignature === 'string' ? req.body.voiceSignature.trim().slice(0, 120) : '';
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'signature')) {
      update.signature = typeof req.body.signature === 'string' ? req.body.signature.trim().slice(0, 160) : '';
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, message: 'No profile info provided' });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: update },
      { new: true, runValidators: true }
    ).select(PUBLIC_USER_FIELDS);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/album-photo', async (req, res) => {
  try {
    const { userId } = req.params;
    const { image } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (!image?.base64) return res.status(400).json({ success: false, message: 'Album photo is required' });

    const userRecord = await User.findById(userId).select('albumPhotos');
    if (!userRecord) return res.status(404).json({ success: false, message: 'User not found' });
    if ((userRecord.albumPhotos || []).length >= 12) return res.status(400).json({ success: false, message: 'Album can contain up to 12 photos' });

    const photoUrl = await uploadHostVerificationImage({
      userId,
      key: 'album-photo',
      image
    });

    const user = await User.findByIdAndUpdate(
      userId,
      { $addToSet: { albumPhotos: photoUrl } },
      { new: true }
    ).select(PUBLIC_USER_FIELDS);

    return res.status(200).json({ success: true, photoUrl, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/settings/:userId/album-photo', async (req, res) => {
  try {
    const { userId } = req.params;
    const { photoUrl } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (!photoUrl) return res.status(400).json({ success: false, message: 'Photo url is required' });

    const user = await User.findByIdAndUpdate(
      userId,
      { $pull: { albumPhotos: photoUrl } },
      { new: true }
    ).select(PUBLIC_USER_FIELDS);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/password', async (req, res) => {
  try {
    const { userId } = req.params;
    const { currentPassword, newPassword } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });

    const user = await User.findById(userId).select('password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.password) {
      const passwordMatches = await bcrypt.compare(currentPassword || '', user.password);
      if (!passwordMatches) return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    return res.status(200).json({ success: true, message: 'Password updated' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/settings/:userId/blacklist', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const user = await User.findById(userId)
      .select('blacklistedUsers')
      .populate('blacklistedUsers', 'name profilePic glixId')
      .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    return res.status(200).json({ success: true, users: user.blacklistedUsers || [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/blacklist', async (req, res) => {
  try {
    const { userId } = req.params;
    const { blockedUserId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(blockedUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid blacklist request' });
    }
    if (userId === blockedUserId) return res.status(400).json({ success: false, message: 'You cannot blacklist yourself' });

    await User.findByIdAndUpdate(userId, { $addToSet: { blacklistedUsers: blockedUserId } });
    const updated = await User.findById(userId).select('blacklistedUsers').populate('blacklistedUsers', 'name profilePic glixId');
    return res.status(200).json({ success: true, users: updated?.blacklistedUsers || [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/settings/:userId/blacklist/:blockedUserId', async (req, res) => {
  try {
    const { userId, blockedUserId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(blockedUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid blacklist request' });
    }

    await User.findByIdAndUpdate(userId, { $pull: { blacklistedUsers: blockedUserId } });
    const updated = await User.findById(userId).select('blacklistedUsers').populate('blacklistedUsers', 'name profilePic glixId');
    return res.status(200).json({ success: true, users: updated?.blacklistedUsers || [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/settings/:userId/diagnostics', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const dbState = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    return res.status(200).json({
      success: true,
      diagnostics: {
        api: 'online',
        database: dbState,
        socket: io.engine?.clientsCount >= 0 ? 'online' : 'unknown',
        serverTime: new Date().toISOString()
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/logout', async (req, res) => {
  try {
    const { userId } = req.params;
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (token) {
      await AuthSession.deleteOne({ tokenHash: hashAuthToken(token) });
    }
    if (mongoose.Types.ObjectId.isValid(userId)) {
      await User.findByIdAndUpdate(userId, { $set: { lastLogin: new Date() } });
    }
    return res.status(200).json({ success: true, message: 'Logged out' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/settings/:userId/account', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    await Promise.all([
      User.findByIdAndDelete(userId, { session }),
      Follow.deleteMany({ $or: [{ followerId: userId }, { followingId: userId }] }, { session }),
      DirectMessage.deleteMany({ $or: [{ senderId: userId }, { receiverId: userId }] }, { session }),
      RewardActivity.deleteMany({ userId }, { session }),
      RewardClaim.deleteMany({ userId }, { session }),
      UserStoreItem.deleteMany({ userId }, { session }),
      AudioRoom.deleteMany({ hostId: userId }, { session }),
      Room.deleteMany({ hostId: userId }, { session })
    ]);

    await User.updateMany({ blacklistedUsers: userId }, { $pull: { blacklistedUsers: userId } }, { session });
    await session.commitTransaction();
    return res.status(200).json({ success: true, message: 'Account deleted' });
  } catch (error) {
    await session.abortTransaction();
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
});

app.get('/profile/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid identity sequence format" });
    await clearExpiredStoreItems(id);
    let user = await User.findById(id).select('-password');
    if (!user) return res.status(404).json({ message: "User not found" });
    user = await ensureUserPublicId(user);
    return res.status(200).json(user);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/profile/:profileUserId/visit', async (req, res) => {
  try {
    const { profileUserId } = req.params;
    const { visitorId } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(profileUserId) || !mongoose.Types.ObjectId.isValid(visitorId)) {
      return res.status(400).json({ success: false, message: 'Invalid profile visit request' });
    }

    if (String(profileUserId) === String(visitorId)) {
      return res.status(200).json({ success: true, recorded: false, message: 'Own profile visit ignored' });
    }

    const [profileUser, visitorExists] = await Promise.all([
      User.findById(profileUserId).select('settings'),
      User.exists({ _id: visitorId })
    ]);

    if (!profileUser || !visitorExists) {
      return res.status(404).json({ success: false, message: 'Profile or visitor not found' });
    }

    if (profileUser.settings?.showProfileVisits === false) {
      return res.status(200).json({ success: true, recorded: false, visible: false });
    }

    const now = new Date();
    await ProfileVisit.findOneAndUpdate(
      { profileUserId, visitorId },
      {
        $set: { visitedAt: now },
        $inc: { visitCount: 1 }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ success: true, recorded: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/profile/:userId/visitors', async (req, res) => {
  try {
    const { userId } = req.params;
    const { viewerId } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const user = await User.findById(userId).select('settings');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.settings?.showProfileVisits === false) {
      return res.status(200).json({ success: true, visible: false, visitors: [] });
    }

    const [totalVisitors, visits] = await Promise.all([
      ProfileVisit.countDocuments({ profileUserId: userId }),
      ProfileVisit.find({ profileUserId: userId })
        .sort({ visitedAt: -1 })
        .limit(limit)
        .populate('visitorId', 'name profilePic glixId daimon countryRegion')
        .lean()
    ]);

    const visitorIds = visits.map(visit => visit.visitorId?._id?.toString()).filter(Boolean);
    const followingSet = new Set();

    if (viewerId && mongoose.Types.ObjectId.isValid(viewerId) && visitorIds.length) {
      const followingRows = await Follow.find({
        followerId: viewerId,
        followingId: { $in: visitorIds }
      }).select('followingId').lean();
      followingRows.forEach(row => followingSet.add(row.followingId.toString()));
    }

    const visitors = visits
      .filter(visit => visit.visitorId)
      .map(visit => ({
        id: visit.visitorId._id?.toString(),
        name: visit.visitorId.name || 'User',
        profilePic: visit.visitorId.profilePic || '',
        glixId: visit.visitorId.glixId || '',
        daimon: visit.visitorId.daimon || 0,
        countryRegion: visit.visitorId.countryRegion || '',
        visitedAt: visit.visitedAt,
        visitCount: visit.visitCount || 1,
        isFollowing: followingSet.has(visit.visitorId._id?.toString())
      }));

    return res.status(200).json({ success: true, visible: true, totalVisitors, visitors });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/profile/:userId/followers', async (req, res) => {
  try {
    const { userId } = req.params;
    const { viewerId } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const rows = await Follow.find({ followingId: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('followerId', 'name profilePic glixId daimon countryRegion')
      .lean();

    const followerIds = rows.map(row => row.followerId?._id?.toString()).filter(Boolean);
    const followingSet = new Set();

    if (viewerId && mongoose.Types.ObjectId.isValid(viewerId) && followerIds.length) {
      const followingRows = await Follow.find({
        followerId: viewerId,
        followingId: { $in: followerIds }
      }).select('followingId').lean();
      followingRows.forEach(row => followingSet.add(row.followingId.toString()));
    }

    const users = rows
      .filter(row => row.followerId)
      .map(row => ({
        id: row.followerId._id?.toString(),
        name: row.followerId.name || 'User',
        profilePic: row.followerId.profilePic || '',
        glixId: row.followerId.glixId || '',
        daimon: row.followerId.daimon || 0,
        countryRegion: row.followerId.countryRegion || '',
        isFollowing: followingSet.has(row.followerId._id?.toString())
      }));

    return res.status(200).json({ success: true, users });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/profile/:userId/following', async (req, res) => {
  try {
    const { userId } = req.params;
    const { viewerId } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const rows = await Follow.find({ followerId: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('followingId', 'name profilePic glixId daimon countryRegion')
      .lean();

    const followingIds = rows.map(row => row.followingId?._id?.toString()).filter(Boolean);
    const followingSet = new Set();

    if (viewerId && mongoose.Types.ObjectId.isValid(viewerId) && followingIds.length) {
      const followingRows = await Follow.find({
        followerId: viewerId,
        followingId: { $in: followingIds }
      }).select('followingId').lean();
      followingRows.forEach(row => followingSet.add(row.followingId.toString()));
    }

    const users = rows
      .filter(row => row.followingId)
      .map(row => ({
        id: row.followingId._id?.toString(),
        name: row.followingId.name || 'User',
        profilePic: row.followingId.profilePic || '',
        glixId: row.followingId.glixId || '',
        daimon: row.followingId.daimon || 0,
        countryRegion: row.followingId.countryRegion || '',
        isFollowing: followingSet.has(row.followingId._id?.toString())
      }));

    return res.status(200).json({ success: true, users });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});


app.post('/check-follow', async (req, res) => {
  try {
    const { followerId, followingId } = req.body;

    const isFollowing = await Follow.exists({
      followerId,
      followingId,
    });

    res.status(200).json({
      isFollowing: !!isFollowing,
    });
  } catch (err) {
    res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});











