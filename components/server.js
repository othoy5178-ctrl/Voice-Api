import 'dotenv/config';
import "./conn.js";
import { Server } from 'socket.io';
import http from 'http';
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import pkg from "agora-token";

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
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import AuthSession from "./AuthSession.js";
import Withdrawal from "./Withdrawal.js";
import MonthlyCommission from "./MonthlyCommission.js";
import CoinSellerTransaction from "./CoinSellerTransaction.js";
import GameCoinTransaction from "./GameCoinTransaction.js";

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

const LIVE_ROOM_STALE_MS = 90 * 1000;

const getLiveRoomFreshCutoff = () => new Date(Date.now() - LIVE_ROOM_STALE_MS);

const getVideoRoomFilter = (roomId) => {
  const stringRoomId = roomId ? roomId.toString() : '';
  if (!stringRoomId) return null;
  if (stringRoomId.startsWith('glix_')) return { channelName: stringRoomId };
  if (mongoose.Types.ObjectId.isValid(stringRoomId)) return { _id: stringRoomId };
  return null;
};

const closeStaleLiveRooms = async () => {
  const cutoff = getLiveRoomFreshCutoff();
  const now = new Date();

  await AudioRoom.updateMany(
    {
      isLive: true,
      $or: [
        { lastHeartbeatAt: { $lt: cutoff } },
        { lastHeartbeatAt: { $exists: false }, createdAt: { $lt: cutoff } }
      ]
    },
    { $set: { isLive: false, speakers: [], audience: [], endedAt: now } }
  );

  await Room.deleteMany({
    $or: [
      { isLive: false },
      { lastHeartbeatAt: { $lt: cutoff } },
      { lastHeartbeatAt: { $exists: false }, createdAt: { $lt: cutoff } }
    ]
  });
};

const createCleanSlotsBlueprint = () => Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  locked: i === 3 || i === 12 || i === 19,
  uid: null,
  username: `${i + 1}`,
  avatar: null,
  isMuted: false
}));


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
  socket.on('join_audio_room', async ({ roomId, userId, name, profilePic, entryVideoUrl }) => {
    try {
      await clearExpiredStoreItems(userId);
      const userData = await User.findById(userId).select('frameUrl entryVideoUrl');
      const frameUrl = userData?.frameUrl || null;

      const stringRoomId = roomId ? roomId.toString() : '';
      socket.join(stringRoomId);
      socket.roomId = stringRoomId;
      socket.userId = userId;
      socket.userName = name;

      // Map connection instance to verify host mappings directly on requests
      if (userId) {
        activeUsers[userId.toString()] = socket.id;
      }

      console.log(`${name} joined real-time room channel: ${stringRoomId}`);

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

      const isVideoRoom = stringRoomId.startsWith('glix_');
      let completeLayoutMatrix = createCleanSlotsBlueprint();

      if (isVideoRoom) {
        const videoRoomDoc = await Room.findOne({ channelName: stringRoomId });
        if (videoRoomDoc && videoRoomDoc.slots) {
          completeLayoutMatrix = videoRoomDoc.slots;
        }
      } else {
        if (mongoose.Types.ObjectId.isValid(stringRoomId)) {
          const audioRoomDoc = await AudioRoom.findById(stringRoomId).populate('speakers.userId', 'name profilePic');
          if (audioRoomDoc && audioRoomDoc.speakers) {
            audioRoomDoc.speakers.filter(speaker => speaker && speaker.userId).forEach(speaker => {
              const index = speaker.slotIndex;
              if (index >= 0 && index < 25) {
                completeLayoutMatrix[index] = {
                  ...completeLayoutMatrix[index],
                  uid: speaker.numericUid || null,
                  username: speaker.userId?.name || "Broadcaster",
                  avatar: speaker.userId?.profilePic || null,
                  frameUrl: speaker.frameUrl || null,
                  isMuted: speaker.isMuted || false
                };
              }
            });
          }
        }
      }

      socket.emit('initialize_room_slots', completeLayoutMatrix);
      await emitRoomStats(stringRoomId);

    } catch (err) {
      console.log("Error inside join initialization workflow logic: ", err);
    }
  });

  // 2. EVENT: Request Slot Change
  socket.on('request_slot_change', async ({ roomId, userId, name, profilePic, frameUrl, targetSlotIndex, numericUid, isMuted, cameraOn }) => {
    try {

      let finalFrameUrl = frameUrl;

      // Fetch from DB only if the client didn't send a frameUrl
      if (!finalFrameUrl) {
        const dbUser = await User.findById(userId).select('frameUrl');
        finalFrameUrl = dbUser?.frameUrl || null;
      }

      const stringRoomId = roomId ? roomId.toString() : '';
      const isVideoRoom = stringRoomId.startsWith('glix_');
      const normalizedSlotIndex = Number(targetSlotIndex);
      if (!Number.isInteger(normalizedSlotIndex) || normalizedSlotIndex < 0) return;
      const queryFilter = isVideoRoom ? { channelName: stringRoomId } : { _id: stringRoomId };

      if (isVideoRoom) {
        if (normalizedSlotIndex > 2) return;

        const videoRoom = await Room.findOne({ channelName: stringRoomId }).select('hostId slots');
        if (!videoRoom) {
          socket.emit('error_notice', { message: 'Video room not found.' });
          return;
        }

        if (normalizedSlotIndex === 0) {
          const isRoomHost = String(userId || '') === String(videoRoom.hostId || '');
          const isClearingHostSlot = profilePic === null || numericUid === null || numericUid === undefined;

          if (!isRoomHost || isClearingHostSlot) {
            socket.emit('error_notice', { message: 'The first video slot is reserved for the room creator.' });
            return;
          }
        }

        const updateData = profilePic === null
          ? {
            "slots.$.uid": null,
            "slots.$.username": normalizedSlotIndex === 0 ? 'Main Host' : `Co-Host ${normalizedSlotIndex + 1}`,
            "slots.$.avatar": null,
            "slots.$.frameUrl": null,
            "slots.$.isMuted": false,
            "slots.$.cameraOn": normalizedSlotIndex === 0
          }
          : {
            "slots.$.uid": parseInt(numericUid, 10),
            "slots.$.username": name,
            "slots.$.avatar": profilePic,
            "slots.$.frameUrl": finalFrameUrl,
            "slots.$.isMuted": !!isMuted,
            "slots.$.cameraOn": !!cameraOn
          };

        await Room.findOneAndUpdate(
          { channelName: stringRoomId, "slots.id": normalizedSlotIndex + 1 },
          { $set: updateData }
        );
      } else {
        if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return;

        if (profilePic === null) {
          await AudioRoom.findOneAndUpdate(queryFilter, {
            $pull: { speakers: { slotIndex: targetSlotIndex } }
          });
        } else {
          await AudioRoom.findOneAndUpdate(queryFilter, {
            $pull: { speakers: { userId: userId } }
          });

          await AudioRoom.findOneAndUpdate(queryFilter, {
            $push: {
              speakers: {
                userId: userId,
                slotIndex: targetSlotIndex,
                numericUid: parseInt(numericUid, 10),
                isMuted: isMuted || false,
                frameUrl: frameUrl
              }
            }
          });
        }
      }

      io.to(stringRoomId).emit('slot_state_changed', {
        slotIndex: normalizedSlotIndex,
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

    } catch (error) {
      console.log("Socket array persistence exception error:", error);
      socket.emit('error_notice', { message: 'Failed to synchronize layout seat state.' });
    }
  });

  // 3. EVENT: Chat Messages
  socket.on('send_message', ({ roomId, senderName, text, userId }) => {
    const stringRoomId = roomId ? roomId.toString() : '';
    io.to(stringRoomId).emit('receive_message', {
      id: Date.now().toString() + Math.random().toString(),
      type: 'user',
      sender: senderName,
      text: text,
      userId: userId
    });
  });

  socket.on('send_gift', async ({ roomId, senderName, hostId, gift, giftName, avatar, userId, quantity, coins }) => {

    console.log('gift data:', userId, roomId, hostId, coins);

    if (!hostId) {
      console.error("Backend Error: Received null hostId!");
      socket.emit('gift_error', { message: "Invalid host ID received." });
      return;
    }

    const coinPrice = Number(coins);
    const giftQuantity = Number(quantity);

    if (!Number.isFinite(coinPrice) || !Number.isFinite(giftQuantity) || coinPrice <= 0 || giftQuantity <= 0) {
      socket.emit('gift_error', { message: "Invalid gift cost received." });
      return;
    }

    const totalCost = coinPrice * giftQuantity;

    const session = await mongoose.startSession();
    session.startTransaction();


    try {
      const sender = await User.findOneAndUpdate(
        { _id: userId, chang: { $gte: totalCost } },
        { $inc: { chang: -totalCost } },
        { new: true, session }
      );

      if (!sender) throw new Error("Insufficient coins");

      // 2. Add earned diamonds to Receiver (Host)
      await User.findByIdAndUpdate(
        hostId,
        { $inc: { daimon: totalCost } },
        { session }
      );

      await GiftTransaction.create([{
        roomId: roomId?.toString(),
        senderId: userId,
        receiverId: hostId,
        giftName,
        giftImage: gift,
        coinPrice,
        quantity: giftQuantity,
        totalCost
      }], { session });


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
      totalCost,
      userId: userId
    });
    await emitRoomStats(stringRoomId);
  });

  // 5. EVENT: Audience Mic Requests (Correctly Un-nested now)
  socket.on('audience_join_request', (data) => {
    if (!data?.hostId || !data?.roomId) return;

    const stringRoomId = data.roomId?.toString?.() || '';
    if (stringRoomId.startsWith('glix_')) {
      const requestedSlotIndex = Number(data.requestedSlotIndex);
      if (!Number.isInteger(requestedSlotIndex) || requestedSlotIndex < 1 || requestedSlotIndex > 2) {
        socket.emit('error_notice', { message: 'Use the Call button to request slot 2 or slot 3.' });
        return;
      }
    }

    const hostSocketId = activeUsers[String(data.hostId)];

    if (hostSocketId) {
      io.to(hostSocketId).emit('receive_join_request', data);
    } else {
      io.to(String(data.roomId)).emit('receive_join_request', data);
    }
  });

  // 6. EVENT: Host Acceptance Decision System Handler
  socket.on('host_request_response', async (data) => {
    try {
      const stringRoomId = data.roomId?.toString();
      const isVideoRoom = stringRoomId?.startsWith?.('glix_');
      const isApproved = data.accepted === true || data.approved === true;
      const acceptedSlotIndex = Number(data.requestedSlotIndex ?? data.slotIndex ?? data.targetSlotIndex);

      if (isVideoRoom) {
        if (isApproved && (!Number.isInteger(acceptedSlotIndex) || acceptedSlotIndex < 1 || acceptedSlotIndex > 2)) {
          socket.emit('error_notice', { message: 'Video callers can only be approved for slot 2 or slot 3.' });
          return;
        }

        const videoPayload = Number.isInteger(acceptedSlotIndex)
          ? { ...data, slotIndex: acceptedSlotIndex, requestedSlotIndex: acceptedSlotIndex }
          : data;

        io.to(stringRoomId).emit('join_request_result', videoPayload);

        if (!isApproved || !data.user) return;
        const acceptedUserId = data.user.userId || data.user._id || data.user.id || data.userId;
        if (!acceptedUserId) return;

        io.to(stringRoomId).emit('slot_state_changed', {
          slotIndex: acceptedSlotIndex,
          user: {
            uid: data.user.uid,
            userId: acceptedUserId,
            username: data.user.username,
            avatar: data.user.avatar,
            frameUrl: data.user.frameUrl || null,
            isMuted: false,
            cameraOn: data.user.cameraOn !== false
          }
        });
        return;
      }

      // Send response to all users
      io.to(stringRoomId).emit('join_request_result', data);

      // If request rejected, stop here
      if (!isApproved || !data.user) return;
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
            slotIndex: acceptedSlotIndex,
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
        slotIndex: acceptedSlotIndex,
        user: {
          uid: data.user.uid,
          userId: acceptedUserId,
          username: data.user.username,
          avatar: data.user.avatar,
          frameUrl: data.user.frameUrl || null,
          isMuted: false
        }
      });

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


  socket.on('room_heartbeat', async ({ roomId, userId }) => {
    try {
      const stringRoomId = roomId ? roomId.toString() : '';
      if (!stringRoomId || !userId) return;

      const now = new Date();
      const videoFilter = getVideoRoomFilter(stringRoomId);
      if (videoFilter) {
        const videoRoom = await Room.findOne(videoFilter);
        if (videoRoom) {
          if (String(videoRoom.hostId) === String(userId)) {
            await Room.updateOne(
              { _id: videoRoom._id },
              { $set: { isLive: true, lastHeartbeatAt: now } }
            );
          }
          return;
        }
      }

      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return;
      await AudioRoom.updateOne(
        { _id: stringRoomId, hostId: userId, isLive: true },
        { $set: { lastHeartbeatAt: now } }
      );
    } catch (error) {
      console.log('Room heartbeat error:', error);
    }
  });

  // 7. EVENT: Safe Disconnect Handler
  socket.on('disconnect', async () => {
    try {
      if (socket.userId) {
        delete activeUsers[socket.userId.toString()];
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

      if (roomId.startsWith('glix_')) {
        const videoRoomDoc = await Room.findOne({ channelName: roomId });

        if (
          videoRoomDoc &&
          videoRoomDoc.hostId &&
          videoRoomDoc.hostId.toString() === currentUserId
        ) {
          io.to(roomId).emit('room_closing', {
            message: 'Host disconnected. Room closed.'
          });

          await Room.deleteOne({ channelName: roomId });
          console.log(`Video room closed because host disconnected: ${roomId}`);
        } else {
          await emitRoomStats(roomId);
        }
        return;
      }

      const room = await AudioRoom.findById(roomId);

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
      }

      if (!roomId || roomId.length !== 24 || !/^[0-9a-fA-F]{24}$/.test(roomId)) {
        return;
      }

      const audioRoomDoc = await AudioRoom.findById(roomId);

      if (
        audioRoomDoc &&
        audioRoomDoc.hostId &&
        audioRoomDoc.hostId.toString() === currentUserId
      ) {
        audioRoomDoc.isLive = false;
        audioRoomDoc.speakers = [];
        audioRoomDoc.audience = [];

        await audioRoomDoc.save();

        io.to(roomId).emit('audio_room_ended', {
          message: 'Host disconnected. Room closed.'
        });

        console.log(`Audio room closed because host disconnected: ${roomId}`);
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

    const uniqueChannelName = `glix_${hostId}_${Date.now().toString().slice(-4)}`;

    const initialSlots = [
      {
        id: 1,
        locked: false,
        uid: parseInt(numericUid, 10),
        username: name || 'Main Host',
        avatar: profilePic || null,
        isMe: false,
        isMuted: false
      },
      { id: 2, locked: false, uid: null, username: 'Co-Host 1', avatar: null, isMe: false, isMuted: false },
      { id: 3, locked: false, uid: null, username: 'Co-Host 2', avatar: null, isMe: false, isMuted: false },
    ];

    const newRoom = new Room({
      channelName: uniqueChannelName,
      hostId,
      title: title || "Glix Live Room",
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
        _id: newRoom._id.toString(),
        channelName: uniqueChannelName
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

    const result = await GiftTransaction.aggregate([
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
    const { title, hostId, numericUid } = req.body;
    const sanitizedUid = parseInt(numericUid, 10) || 0;

    const newRoom = new AudioRoom({
      title: title || "Live Audio Room",
      hostId,
      isLive: true,
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

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    let roomObj = null;
    let isVideoRoom = false;
    let channelName = stringRoomId;
    let userRole = RtcRole.SUBSCRIBER;

    const videoFilter = getVideoRoomFilter(stringRoomId);
    if (videoFilter) {
      roomObj = await Room.findOne(videoFilter);
      if (roomObj) {
        isVideoRoom = true;
        channelName = roomObj.channelName;
        await Room.findByIdAndUpdate(roomObj._id, {
          $set: { isLive: true, lastHeartbeatAt: new Date() }
        });
      }
    }

    if (!isVideoRoom) {
      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return res.status(400).json({ error: "Invalid Room ID format" });
      roomObj = await AudioRoom.findById(stringRoomId);
      if (!roomObj) return res.status(404).json({ error: "Audio room not found" });
      if (!roomObj.isLive) return res.status(400).json({ error: "This room has already ended" });

      await AudioRoom.findByIdAndUpdate(stringRoomId, {
        $pull: {
          speakers: { userId }
        },
        $set: { lastHeartbeatAt: new Date() }
      });

      roomObj = await AudioRoom.findById(stringRoomId);

      const currentSpeakers = Array.isArray(roomObj.speakers) ? roomObj.speakers : [];
      const currentAudience = Array.isArray(roomObj.audience) ? roomObj.audience : [];
      const validSpeakers = currentSpeakers.filter(s => s && s.userId);
      const validAudience = currentAudience.filter(Boolean);
      if (validSpeakers.length !== currentSpeakers.length || validAudience.length !== currentAudience.length) {
        roomObj.speakers = validSpeakers;
        roomObj.audience = validAudience;
        await roomObj.save();
      }

      const isAlreadySpeaker = validSpeakers.some(s => String(s.userId) === String(userId));
      const isAlreadyAudience = validAudience.some(id => String(id) === String(userId));

      if (isAlreadySpeaker) {
        userRole = RtcRole.PUBLISHER;
      } else if (!isAlreadyAudience) {
        roomObj.audience.push(userId);
        await roomObj.save();
      }
    }

    if (!roomObj) return res.status(404).json({ error: "Room not found" });

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      sanitizedUid,
      userRole,
      privilegeExpiredTs
    );

    await recordRewardActivity(userId, isVideoRoom ? 'join_video_room' : 'join_audio_room', { roomId: roomObj._id?.toString?.() || stringRoomId });

    return res.status(200).json({
      success: true,
      room: {
        hostId: roomObj.hostId,
        _id: roomObj._id.toString(),
        channelName
      },
      agoraToken: token,
      channelName,
      appId: appId,
      userRole: userRole === RtcRole.PUBLISHER ? 'speaker' : 'audience'
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

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
    const videoFilter = getVideoRoomFilter(stringRoomId);

    if (videoFilter) {
      const videoRoom = await Room.findOne(videoFilter);
      if (videoRoom) {
        if (!videoRoom.hostId || videoRoom.hostId.toString() !== String(hostId)) {
          return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        io.to(videoRoom.channelName).emit('room_closing', { message: 'The host has ended the video live stream.' });
        await Room.deleteOne({ _id: videoRoom._id });
        await new Promise(resolve => setTimeout(resolve, 500));
        return res.status(200).json({ success: true, message: "Room closed cleanly." });
      }
    }

    if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return res.status(400).json({ error: "Malformed ID structure" });

    const room = await AudioRoom.findById(stringRoomId);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
    if (!room.hostId || room.hostId.toString() !== String(hostId)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    room.isLive = false;
    room.speakers = [];
    room.audience = [];
    room.endedAt = new Date();
    await room.save();

    io.to(stringRoomId).emit('audio_room_ended', {
      message: "The live audio room has been closed by the host."
    });

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
    await closeStaleLiveRooms();
    const liveRooms = await Room.find({
      isLive: true,
      lastHeartbeatAt: { $gte: getLiveRoomFreshCutoff() }
    }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, rooms: liveRooms });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/rooms', async (req, res) => {
  try {
    await closeStaleLiveRooms();
    const liveRooms = await AudioRoom.find({
      isLive: true,
      lastHeartbeatAt: { $gte: getLiveRoomFreshCutoff() }
    }).populate('hostId', 'name profilePic username').sort({ createdAt: -1 });
    const formattedRooms = liveRooms.map(room => ({
      id: room._id,
      title: room.title,
      host: room.hostId,
      speakerCount: room.speakers.length,
      audienceCount: room.audience.length,
      createdAt: room.createdAt
    }));
    return res.status(200).json({ success: true, rooms: formattedRooms });
  } catch (error) {
    return res.status(500).json({ error: error.message });
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
      return res.status(200).json({
        message: 'Login successful!',
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
    return res.status(201).json({
      message: 'Registered!',
      user: { id: newUser._id, name: newUser.name, email: newUser.email, glixId: newUser.glixId }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});



const getCurrentWeekPeriodMatch = (period) => {
  if (!['weekday', 'weekend'].includes(period)) return null;

  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);

  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);

  return period === 'weekday'
    ? { createdAt: { $gte: monday, $lt: friday } }
    : { createdAt: { $gte: friday, $lt: nextMonday } };
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
  const periodMatch = getCurrentWeekPeriodMatch(period);
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
  const periodMatch = getCurrentWeekPeriodMatch(period);
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
    const period = (req.query.period || 'weekend').toLowerCase();
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

const PUBLIC_USER_FIELDS = 'name email profilePic glixId googleId createdAt lastLogin followersCount followingCount daimon chang frameUrl entryVideoUrl settings blacklistedUsers';

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

app.get('/profile/:userId/fans', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const rows = await Follow.find({ followingId: userId })
      .populate('followerId', 'name profilePic glixId daimon countryRegion')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const fans = rows
      .filter(row => row.followerId)
      .map(row => ({
        id: row.followerId._id,
        name: row.followerId.name || 'User',
        profilePic: row.followerId.profilePic || '',
        glixId: row.followerId.glixId || '',
        daimon: row.followerId.daimon || 0,
        countryRegion: row.followerId.countryRegion || '',
        followedAt: row.createdAt
      }));

    return res.status(200).json({ success: true, fans });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/gift-gallery/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const gifts = await GiftTransaction.aggregate([
      { $match: { receiverId: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: { giftName: '$giftName', giftImage: '$giftImage' },
          quantity: { $sum: '$quantity' },
          totalCoins: { $sum: '$totalCost' },
          transactions: { $sum: 1 },
          latestAt: { $max: '$createdAt' }
        }
      },
      { $sort: { totalCoins: -1, quantity: -1, latestAt: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          giftName: '$_id.giftName',
          giftImage: '$_id.giftImage',
          quantity: 1,
          totalCoins: 1,
          transactions: 1,
          latestAt: 1
        }
      }
    ]);

    const totals = gifts.reduce((acc, gift) => {
      acc.quantity += Number(gift.quantity || 0);
      acc.totalCoins += Number(gift.totalCoins || 0);
      return acc;
    }, { quantity: 0, totalCoins: 0 });

    return res.status(200).json({ success: true, gifts, totals });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
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



const OFFICIAL_SESSION_DAYS = Number(process.env.OFFICIAL_SESSION_DAYS || 7);
const OFFICIAL_SESSION_MS = OFFICIAL_SESSION_DAYS * 24 * 60 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

const officialUserProjection = 'name email profilePic glixId role accountStatus createdAt lastLogin chang daimon hostStatus agencyStatus coinSellerStatus sellerBalance sellerTotalSold adminNote';

const serializeOfficialUser = (user) => {
  if (!user) return null;
  const plain = typeof user.toObject === 'function' ? user.toObject() : user;
  const { password, passwordResetOtpHash, ...safe } = plain;
  return safe;
};

const createOfficialSession = async (userId) => {
  const token = crypto.randomBytes(32).toString('hex');
  await AuthSession.create({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + OFFICIAL_SESSION_MS),
  });
  return token;
};

const requireOfficial = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) return res.status(401).json({ success: false, message: 'Official token missing' });

    const session = await AuthSession.findOne({
      tokenHash: hashToken(token),
      expiresAt: { $gt: new Date() },
    }).populate('userId');

    const officialUser = session?.userId;
    if (!officialUser) return res.status(401).json({ success: false, message: 'Official session expired' });
    if (officialUser.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only the Super Admin can access the Official Portal' });
    }
    if ((officialUser.accountStatus || 'active') !== 'active') {
      return res.status(403).json({ success: false, message: `Official account is ${officialUser.accountStatus}` });
    }

    req.officialUser = officialUser;
    session.lastUsedAt = new Date();
    session.save().catch(() => {});
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || 'Official auth failed' });
  }
};

const findUserByIdentifier = async (identifier) => {
  const clean = String(identifier || '').trim();
  if (!clean) return null;
  const or = [{ email: clean.toLowerCase() }, { glixId: clean }];
  if (mongoose.Types.ObjectId.isValid(clean)) or.push({ _id: clean });
  return User.findOne({ $or: or });
};

const getMonthRange = (monthValue) => {
  const now = new Date();
  const clean = String(monthValue || '').trim() || now.toISOString().slice(0, 7);
  const [year, month] = clean.split('-').map(Number);
  if (!year || !month) return { month: now.toISOString().slice(0, 7), start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
  return { month: clean, start: new Date(year, month - 1, 1), end: new Date(year, month, 1) };
};


const getQuantumNexusSharedKey = () => String(process.env.QUANTUM_NEXUS_SHARED_KEY || '').trim();
const quantumMd5 = (value) => crypto.createHash('md5').update(String(value || '')).digest('hex');
const normalizeProviderRoomId = (payload = {}) => String(payload.roomId ?? payload.roomid ?? '').trim();

const verifyQuantumSign = (providedSign, expectedRawValue) => {
  const incoming = String(providedSign || '').trim().toLowerCase();
  const expected = quantumMd5(expectedRawValue).toLowerCase();
  return !!incoming && incoming === expected;
};

const providerError = (res, errorCode, errorMsg, data = null) => res.json({
  errorCode,
  errorMsg,
  data,
});

const validateQuantumUserSession = async (uid, token) => {
  if (!mongoose.Types.ObjectId.isValid(uid)) return null;
  const session = await AuthSession.findOne({
    userId: uid,
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!session) return null;
  return User.findById(uid).select('_id name profilePic chang').lean();
};

const serializeQuantumUser = (user) => ({
  uid: user?._id?.toString() || '',
  nickname: user?.name || 'Glix User',
  avatar: user?.profilePic || '',
  coin: Math.max(0, Math.floor(Number(user?.chang || 0))),
});

const resolveQuantumFriendIds = async (uid) => {
  const [followingDocs, followerDocs] = await Promise.all([
    Follow.find({ followerId: uid }).select('followingId').lean(),
    Follow.find({ followingId: uid }).select('followerId').lean(),
  ]);
  const ids = [...followingDocs.map(item => item.followingId), ...followerDocs.map(item => item.followerId)]
    .filter(Boolean)
    .map(item => item.toString());
  return [...new Set(ids)];
};

const handleQuantumFriendsList = async (req, res) => {
  try {
    const sharedKey = getQuantumNexusSharedKey();
    const uid = String(req.body?.uid || '').trim();
    const token = String(req.body?.token || '').trim();
    const sign = String(req.body?.sign || '').trim();

    if (!sharedKey) return providerError(res, 503, 'Shared key is not configured.', []);
    if (!uid || !token || !sign) return providerError(res, 400, 'uid, token and sign are required.', []);
    if (!verifyQuantumSign(sign, `${uid}${token}${sharedKey}`)) return providerError(res, 401, 'Invalid signature.', []);

    const user = await validateQuantumUserSession(uid, token);
    if (!user) return providerError(res, 401, 'Invalid user session.', []);

    const friendIds = await resolveQuantumFriendIds(uid);
    if (!friendIds.length) return res.json({ errorCode: 0, errorMsg: 'Success', data: [] });

    const friends = await User.find({ _id: { $in: friendIds } }).select('_id name glixId profilePic').lean();
    return res.json({
      errorCode: 0,
      errorMsg: 'Success',
      data: friends.map(friend => ({
        uid: friend._id?.toString(),
        nickname: friend.name || friend.glixId || 'Glix User',
        avatar: friend.profilePic || '',
      })),
    });
  } catch (error) {
    console.log('Quantum Nexus friend list error:', error.message);
    return providerError(res, 500, 'Internal server error.', []);
  }
};

const handleQuantumUserInfo = async (req, res) => {
  try {
    const sharedKey = getQuantumNexusSharedKey();
    const gameId = String(req.body?.gameId || '').trim();
    const uid = String(req.body?.uid || '').trim();
    const token = String(req.body?.token || '').trim();
    const roomId = normalizeProviderRoomId(req.body);
    const sign = String(req.body?.sign || '').trim();

    if (!sharedKey) return providerError(res, 503, 'Shared key is not configured.', null);
    if (!gameId || !uid || !token || !sign) return providerError(res, 400, 'gameId, uid, token and sign are required.', null);
    if (!verifyQuantumSign(sign, `${gameId}${uid}${token}${roomId}${sharedKey}`)) return providerError(res, 401, 'Invalid signature.', null);

    const user = await validateQuantumUserSession(uid, token);
    if (!user) return providerError(res, 401, 'Invalid user session.', null);

    return res.json({ errorCode: 0, errorMsg: 'Success', data: serializeQuantumUser(user) });
  } catch (error) {
    console.log('Quantum Nexus user info error:', error.message);
    return providerError(res, 500, 'Internal server error.', null);
  }
};

const getExistingGameCoinResult = async (orderId, res) => {
  const existing = await GameCoinTransaction.findOne({ orderId }).select('balanceAfter').lean();
  if (!existing) return null;
  return res.json({ errorCode: 0, errorMsg: 'Success', data: { coin: existing.balanceAfter } });
};

const handleQuantumCoinUpdate = async (req, res) => {
  try {
    const sharedKey = getQuantumNexusSharedKey();
    const orderId = String(req.body?.orderId || '').trim();
    const gameId = String(req.body?.gameId || '').trim();
    const roundId = String(req.body?.roundId || '').trim();
    const uid = String(req.body?.uid || '').trim();
    const coin = Math.floor(Number(req.body?.coin));
    const type = Number(req.body?.type);
    const rewardType = Number(req.body?.rewardType);
    const token = String(req.body?.token || '').trim();
    const winId = String(req.body?.winId || '').trim();
    const roomId = normalizeProviderRoomId(req.body);
    const sign = String(req.body?.sign || '').trim();

    if (!sharedKey) return providerError(res, 503, 'Shared key is not configured.', null);
    if (!orderId || !gameId || !roundId || !uid || !token || !sign || !Number.isFinite(coin) || coin < 0 || ![1, 2].includes(type) || !Number.isFinite(rewardType)) {
      return providerError(res, 400, 'Invalid request parameters.', null);
    }
    if (!verifyQuantumSign(sign, `${orderId}${gameId}${roundId}${uid}${coin}${type}${rewardType}${token}${winId}${sharedKey}`)) {
      return providerError(res, 401, 'Invalid signature.', null);
    }

    const duplicateResult = await getExistingGameCoinResult(orderId, res);
    if (duplicateResult) return duplicateResult;

    const user = await validateQuantumUserSession(uid, token);
    if (!user) return providerError(res, 401, 'Invalid user session.', null);

    const update = type === 1
      ? { $inc: { chang: -coin } }
      : { $inc: { chang: coin } };
    const query = type === 1
      ? { _id: uid, chang: { $gte: coin } }
      : { _id: uid };

    const updatedUser = await User.findOneAndUpdate(query, update, { new: true }).select('_id chang');
    if (!updatedUser) return providerError(res, 402, 'Insufficient coins.', null);

    const balanceAfter = Math.max(0, Math.floor(Number(updatedUser.chang || 0)));
    await GameCoinTransaction.create({
      orderId,
      gameId,
      roundId,
      userId: uid,
      coin,
      type,
      rewardType,
      winId,
      roomId,
      balanceAfter,
    });

    return res.json({ errorCode: 0, errorMsg: 'Success', data: { coin: balanceAfter } });
  } catch (error) {
    if (error?.code === 11000 && req.body?.orderId) {
      const existing = await GameCoinTransaction.findOne({ orderId: String(req.body.orderId).trim() }).select('balanceAfter').lean();
      if (existing) return res.json({ errorCode: 0, errorMsg: 'Success', data: { coin: existing.balanceAfter } });
    }
    console.log('Quantum Nexus coin update error:', error.message);
    return providerError(res, 500, 'Internal server error.', null);
  }
};

const handleQuantumCoinSupplement = async (req, res) => {
  try {
    const sharedKey = getQuantumNexusSharedKey();
    const orderId = String(req.body?.orderId || '').trim();
    const gameId = String(req.body?.gameId || '').trim();
    const roundId = String(req.body?.roundId || '').trim();
    const uid = String(req.body?.uid || '').trim();
    const coin = Math.floor(Number(req.body?.coin));
    const rewardType = Number(req.body?.rewardType);
    const winId = String(req.body?.winId || '').trim();
    const roomId = normalizeProviderRoomId(req.body);
    const sign = String(req.body?.sign || '').trim();

    if (!sharedKey) return providerError(res, 503, 'Shared key is not configured.', null);
    if (!orderId || !gameId || !roundId || !uid || !sign || !Number.isFinite(coin) || coin < 0 || !Number.isFinite(rewardType)) {
      return providerError(res, 400, 'Invalid request parameters.', null);
    }
    if (!verifyQuantumSign(sign, `${orderId}${gameId}${roundId}${uid}${coin}${rewardType}${winId}${sharedKey}`)) {
      return providerError(res, 401, 'Invalid signature.', null);
    }

    const duplicateResult = await getExistingGameCoinResult(orderId, res);
    if (duplicateResult) return duplicateResult;

    if (!mongoose.Types.ObjectId.isValid(uid)) return providerError(res, 400, 'Invalid uid.', null);
    const updatedUser = await User.findByIdAndUpdate(uid, { $inc: { chang: coin } }, { new: true }).select('_id chang');
    if (!updatedUser) return providerError(res, 404, 'User not found.', null);

    const balanceAfter = Math.max(0, Math.floor(Number(updatedUser.chang || 0)));
    await GameCoinTransaction.create({
      orderId,
      gameId,
      roundId,
      userId: uid,
      coin,
      type: 2,
      rewardType,
      winId,
      roomId,
      balanceAfter,
    });

    return res.json({ errorCode: 0, errorMsg: 'Success', data: { coin: balanceAfter } });
  } catch (error) {
    if (error?.code === 11000 && req.body?.orderId) {
      const existing = await GameCoinTransaction.findOne({ orderId: String(req.body.orderId).trim() }).select('balanceAfter').lean();
      if (existing) return res.json({ errorCode: 0, errorMsg: 'Success', data: { coin: existing.balanceAfter } });
    }
    console.log('Quantum Nexus coin supplement error:', error.message);
    return providerError(res, 500, 'Internal server error.', null);
  }
};

app.post('/api/friends/list', handleQuantumFriendsList);
app.post('/api/user/info', handleQuantumUserInfo);
app.post('/api/game/user-info', handleQuantumUserInfo);
app.post('/api/game/coin/update', handleQuantumCoinUpdate);
app.post('/api/game/update-coin', handleQuantumCoinUpdate);
app.post('/api/game/coin/supplement', handleQuantumCoinSupplement);
app.post('/api/game/supplement-coin', handleQuantumCoinSupplement);

app.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    const user = await User.findOne({ email });
    if (!user || !user.password) return res.status(401).json({ success: false, message: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid email or password' });

    if (user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only the Super Admin can access the Official Portal' });
    }
    if ((user.accountStatus || 'active') !== 'active') {
      return res.status(403).json({ success: false, message: `Your account is ${user.accountStatus}` });
    }

    user.lastLogin = new Date();
    if (!user.glixId) user.glixId = await createUniqueUserPublicId();
    await user.save();

    const token = await createOfficialSession(user._id);
    return res.json({ success: true, token, user: serializeOfficialUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/auth/forgot-password', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user || user.role !== 'super_admin') {
      return res.status(404).json({ success: false, message: 'Official account not found' });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    user.passwordResetOtpHash = await bcrypt.hash(otp, 10);
    user.passwordResetOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    user.passwordResetOtpRequestedAt = new Date();
    user.passwordResetOtpAttempts = 0;
    await user.save();

    console.log(`Official portal password reset OTP for ${email}: ${otp}`);
    return res.json({ success: true, message: 'OTP generated. Check backend logs or configure email delivery.', devOtp: otp });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/auth/reset-password', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    const user = await User.findOne({ email });
    if (!user || user.role !== 'super_admin') return res.status(404).json({ success: false, message: 'Official account not found' });
    if (!user.passwordResetOtpHash || !user.passwordResetOtpExpiresAt || user.passwordResetOtpExpiresAt < new Date()) {
      return res.status(400).json({ success: false, message: 'OTP expired. Request a new code.' });
    }
    if ((user.passwordResetOtpAttempts || 0) >= 5) {
      return res.status(429).json({ success: false, message: 'Too many OTP attempts. Request a new code.' });
    }
    const validOtp = await bcrypt.compare(otp, user.passwordResetOtpHash);
    if (!validOtp) {
      user.passwordResetOtpAttempts = (user.passwordResetOtpAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }
    if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordResetOtpHash = '';
    user.passwordResetOtpExpiresAt = null;
    user.passwordResetOtpRequestedAt = null;
    user.passwordResetOtpAttempts = 0;
    await user.save();
    await AuthSession.deleteMany({ userId: user._id });
    return res.json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/access/register', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const note = String(req.body?.note || '').trim();
    const requestedRole = ['admin', 'manager', 'super_admin'].includes(req.body?.requestedRole)
      ? req.body.requestedRole
      : 'super_admin';
    if (!name || !email || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Name, email and a 6 character password are required' });
    }

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        name,
        email,
        password: await bcrypt.hash(password, 10),
        glixId: await createUniqueUserPublicId(),
        role: 'user',
      });
    }

    user.adminAccessRequest = {
      requestedRole,
      status: 'pending',
      note,
      rejectionReason: '',
      reviewedBy: null,
      reviewedAt: null,
      requestedAt: new Date(),
    };
    await user.save();
    return res.json({ success: true, message: 'Official access request submitted' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/access/request', async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const requestedRole = String(req.body?.requestedRole || '').trim();
    const note = String(req.body?.note || '').trim();

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }
    if (!['admin', 'manager'].includes(requestedRole)) {
      return res.status(400).json({ success: false, message: 'Only admin or manager can be requested from the app' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.role === requestedRole) {
      return res.status(400).json({ success: false, message: `You already have ${requestedRole} access` });
    }
    if (user.adminAccessRequest?.status === 'pending' && user.adminAccessRequest?.requestedRole === requestedRole) {
      return res.status(409).json({ success: false, message: 'This request is already pending' });
    }

    user.adminAccessRequest = {
      requestedRole,
      status: 'pending',
      note,
      rejectionReason: '',
      reviewedBy: null,
      reviewedAt: null,
      requestedAt: new Date(),
    };
    await user.save();

    return res.json({ success: true, message: 'Request submitted for Super Admin approval.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});
app.get('/admin/dashboard', requireOfficial, async (req, res) => {
  try {
    await closeStaleLiveRooms();
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    const [totalUsers, activeUsers, suspendedUsers, pendingHosts, pendingAgencies, pendingWithdrawals, liveAudioRooms, liveVideoRooms, weeklyGiftAgg] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ accountStatus: 'active' }),
      User.countDocuments({ accountStatus: { $in: ['suspended', 'banned'] } }),
      User.countDocuments({ hostStatus: 'pending' }),
      User.countDocuments({ agencyStatus: 'pending' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      AudioRoom.countDocuments({ isLive: true, lastHeartbeatAt: { $gte: getLiveRoomFreshCutoff() } }),
      Room.countDocuments({ lastHeartbeatAt: { $gte: getLiveRoomFreshCutoff() } }),
      GiftTransaction.aggregate([
        { $match: { createdAt: { $gte: weekStart } } },
        { $group: { _id: null, coins: { $sum: '$totalCost' }, count: { $sum: 1 } } },
      ]),
    ]);
    const weeklyGift = weeklyGiftAgg?.[0] || {};
    return res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        suspendedUsers,
        pendingHosts,
        pendingAgencies,
        pendingWithdrawals,
        liveRooms: liveAudioRooms + liveVideoRooms,
        liveAudioRooms,
        liveVideoRooms,
        weeklyGiftCoins: weeklyGift.coins || 0,
        weeklyGiftTransactions: weeklyGift.count || 0,
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/users', requireOfficial, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const query = {};
    if (req.query.role && req.query.role !== 'all') query.role = req.query.role;
    if (req.query.accountStatus && req.query.accountStatus !== 'all') query.accountStatus = req.query.accountStatus;
    const search = String(req.query.search || '').trim();
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { glixId: { $regex: search, $options: 'i' } },
      ];
    }

    const [total, users] = await Promise.all([
      User.countDocuments(query),
      User.find(query).select(officialUserProjection).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    return res.json({ success: true, users, page, pages: Math.max(1, Math.ceil(total / limit)), total });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/users/:userId', requireOfficial, async (req, res) => {
  try {
    const allowed = ['role', 'accountStatus', 'hostStatus', 'agencyStatus', 'chang', 'daimon', 'adminNote'];
    const update = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
    }
    if (update.chang !== undefined) update.chang = Math.max(0, Number(update.chang) || 0);
    if (update.daimon !== undefined) update.daimon = Math.max(0, Number(update.daimon) || 0);

    if (String(req.params.userId) === String(req.officialUser._id)) {
      if (update.role && update.role !== 'super_admin') return res.status(400).json({ success: false, message: 'You cannot remove your own Super Admin role' });
      if (update.accountStatus && update.accountStatus !== 'active') return res.status(400).json({ success: false, message: 'You cannot disable your own Official account' });
    }

    const user = await User.findByIdAndUpdate(req.params.userId, { $set: update }, { new: true, runValidators: true }).select(officialUserProjection);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/host/requests', requireOfficial, async (req, res) => {
  try {
    const requests = await User.find({ hostStatus: 'pending' }).select('-password -passwordResetOtpHash').sort({ 'hostRegistration.registeredAt': -1, createdAt: -1 }).lean();
    return res.json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/host/requests/:userId', requireOfficial, async (req, res) => {
  try {
    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, message: 'Invalid host status' });
    const update = {
      hostStatus: status,
      hostRejectionReason: status === 'rejected' ? String(req.body?.reason || '') : '',
      'hostRegistration.status': status,
      'hostRegistration.rejectionReason': status === 'rejected' ? String(req.body?.reason || '') : '',
      'hostRegistration.reviewedBy': req.officialUser._id,
      'hostRegistration.reviewedAt': new Date(),
    };
    if (status === 'approved') update.role = 'host';
    const user = await User.findByIdAndUpdate(req.params.userId, { $set: update }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/agency/requests', requireOfficial, async (req, res) => {
  try {
    const requests = await User.find({ agencyStatus: 'pending' }).select('-password -passwordResetOtpHash').sort({ 'agencyRegistration.registeredAt': -1, createdAt: -1 }).lean();
    return res.json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/agency/requests/:userId', requireOfficial, async (req, res) => {
  try {
    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, message: 'Invalid agency status' });
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.agencyStatus = status;
    user.agencyRejectionReason = status === 'rejected' ? String(req.body?.reason || '') : '';
    user.agencyRegistration.status = status;
    user.agencyRegistration.rejectionReason = user.agencyRejectionReason;
    user.agencyRegistration.reviewedBy = req.officialUser._id;
    user.agencyRegistration.reviewedAt = new Date();
    if (status === 'approved') {
      user.role = 'agency';
      user.agencyCode = (user.agencyRegistration?.requestedAgencyCode || user.agencyCode || `AG${String(user.glixId || user._id).slice(-5)}`).toUpperCase();
    }
    await user.save();
    return res.json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/access/requests', requireOfficial, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const query = status === 'all' ? { 'adminAccessRequest.status': { $ne: 'none' } } : { 'adminAccessRequest.status': status };
    const requests = await User.find(query).select('-password -passwordResetOtpHash').sort({ 'adminAccessRequest.requestedAt': -1 }).lean();
    return res.json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/access/requests/:userId', requireOfficial, async (req, res) => {
  try {
    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, message: 'Invalid request status' });

    const targetUser = await User.findById(req.params.userId).select('adminAccessRequest');
    if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });

    const requestedRole = ['admin', 'manager', 'super_admin'].includes(req.body?.role)
      ? req.body.role
      : targetUser.adminAccessRequest?.requestedRole;
    if (status === 'approved' && !['admin', 'manager', 'super_admin'].includes(requestedRole)) {
      return res.status(400).json({ success: false, message: 'Invalid requested role' });
    }

    const update = {
      'adminAccessRequest.status': status,
      'adminAccessRequest.reviewedBy': req.officialUser._id,
      'adminAccessRequest.reviewedAt': new Date(),
      'adminAccessRequest.rejectionReason': status === 'rejected' ? String(req.body?.reason || '') : '',
    };
    if (status === 'approved') {
      update.role = requestedRole;
      update.accountStatus = 'active';
    }
    const user = await User.findByIdAndUpdate(req.params.userId, { $set: update }, { new: true, runValidators: true });
    return res.json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});
app.get('/admin/withdrawals', requireOfficial, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const query = status === 'all' ? {} : { status };
    const withdrawals = await Withdrawal.find(query).populate('userId', 'name email glixId').sort({ createdAt: -1 }).lean();
    return res.json({ success: true, withdrawals });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/withdrawals/:withdrawalId', requireOfficial, async (req, res) => {
  try {
    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, message: 'Invalid withdrawal status' });
    const withdrawal = await Withdrawal.findByIdAndUpdate(req.params.withdrawalId, {
      $set: {
        status,
        reviewerId: req.officialUser._id,
        reviewNote: String(req.body?.reason || ''),
        reviewedAt: new Date(),
      }
    }, { new: true }).populate('userId', 'name email glixId');
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    return res.json({ success: true, withdrawal });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/agencies', requireOfficial, async (req, res) => {
  try {
    const agencies = await User.aggregate([
      { $match: { $or: [{ role: 'agency' }, { agencyStatus: 'approved' }] } },
      { $lookup: { from: 'users', localField: '_id', foreignField: 'agencyId', as: 'hosts' } },
      { $project: { name: 1, email: 1, glixId: 1, agencyCode: 1, totalHostCoins: 1, commissionBalance: 1, hostsCount: { $size: '$hosts' } } },
      { $sort: { createdAt: -1 } },
    ]);
    return res.json({ success: true, agencies });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/agencies', requireOfficial, async (req, res) => {
  try {
    const agency = await findUserByIdentifier(req.body?.identifier);
    if (!agency) return res.status(404).json({ success: false, message: 'Agency user not found' });
    const agencyCode = String(req.body?.agencyCode || agency.agencyCode || `AG${String(agency.glixId || agency._id).slice(-5)}`).trim().toUpperCase();
    agency.role = 'agency';
    agency.agencyStatus = 'approved';
    agency.agencyCode = agencyCode;
    agency.agencyRegistration.status = 'approved';
    agency.agencyRegistration.reviewedBy = req.officialUser._id;
    agency.agencyRegistration.reviewedAt = new Date();
    await agency.save();
    return res.json({ success: true, agency: serializeOfficialUser(agency) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/store/items', requireOfficial, async (req, res) => {
  try {
    const items = await StoreItem.find({}).sort({ sortOrder: 1, createdAt: -1 }).lean();
    return res.json({ success: true, items });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/store/items', requireOfficial, async (req, res) => {
  try {
    const payload = { ...req.body, price: Number(req.body?.price) || 0, durationDays: Number(req.body?.durationDays) || 0, sortOrder: Number(req.body?.sortOrder) || 0 };
    const item = await StoreItem.create(payload);
    return res.status(201).json({ success: true, item });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/store/items/:itemId', requireOfficial, async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.price !== undefined) payload.price = Number(payload.price) || 0;
    if (payload.durationDays !== undefined) payload.durationDays = Number(payload.durationDays) || 0;
    if (payload.sortOrder !== undefined) payload.sortOrder = Number(payload.sortOrder) || 0;
    const item = await StoreItem.findByIdAndUpdate(req.params.itemId, { $set: payload }, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ success: false, message: 'Store item not found' });
    return res.json({ success: true, item });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});


const sellerProjection = 'name email profilePic glixId role accountStatus coinSellerStatus coinSellerRegistration sellerBalance sellerTotalSold createdAt';

const serializeSeller = (user) => {
  if (!user) return null;
  const plain = typeof user.toObject === 'function' ? user.toObject() : user;
  const { password, passwordResetOtpHash, adminAccessRequest, ...safe } = plain;
  return safe;
};

const requireCoinSeller = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) return res.status(401).json({ success: false, message: 'Seller token missing' });

    const session = await AuthSession.findOne({
      tokenHash: hashToken(token),
      expiresAt: { $gt: new Date() },
    }).populate('userId');

    const seller = session?.userId;
    if (!seller) return res.status(401).json({ success: false, message: 'Seller session expired' });
    if ((seller.accountStatus || 'active') !== 'active') {
      return res.status(403).json({ success: false, message: `Account is ${seller.accountStatus}` });
    }
    if (seller.coinSellerStatus !== 'approved' && seller.role !== 'coin_seller') {
      return res.status(403).json({ success: false, message: `Coin seller request is ${seller.coinSellerStatus || 'not approved'}` });
    }

    req.coinSeller = seller;
    session.lastUsedAt = new Date();
    session.save().catch(() => {});
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || 'Seller auth failed' });
  }
};

app.post('/coin-seller/register', async (req, res) => {
  try {
    const name = String(req.body?.name || req.body?.fullName || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const phoneNumber = String(req.body?.phoneNumber || '').trim();
    const city = String(req.body?.city || '').trim();
    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const note = String(req.body?.note || '').trim();

    if (!name || !email || password.length < 6 || !phoneNumber) {
      return res.status(400).json({ success: false, message: 'Name, email, password and phone number are required' });
    }

    let user = await User.findOne({ email });
    if (user?.coinSellerStatus === 'approved' || user?.coinSellerRegistration?.status === 'approved') {
      return res.status(409).json({ success: false, message: 'This account is already an approved coin seller' });
    }
    if (user?.coinSellerStatus === 'pending' || user?.coinSellerRegistration?.status === 'pending') {
      return res.status(409).json({ success: false, message: 'Your coin seller request is already pending' });
    }

    if (!user) {
      user = new User({
        name,
        email,
        password: await bcrypt.hash(password, 10),
        glixId: await createUniqueUserPublicId(),
      });
    } else {
      const passwordMatches = user.password ? await bcrypt.compare(password, user.password) : false;
      if (user.password && !passwordMatches) {
        return res.status(401).json({ success: false, message: 'This email already exists. Use the correct password to request seller access.' });
      }
      if (!user.password) user.password = await bcrypt.hash(password, 10);
      user.name = user.name || name;
      if (!user.glixId) user.glixId = await createUniqueUserPublicId();
    }

    user.coinSellerStatus = 'pending';
    user.coinSellerRejectionReason = '';
    user.coinSellerRegistration = {
      ...(user.coinSellerRegistration?.toObject ? user.coinSellerRegistration.toObject() : user.coinSellerRegistration || {}),
      fullName: name,
      phoneNumber,
      city,
      paymentMethod,
      note,
      status: 'pending',
      rejectionReason: '',
      reviewedBy: null,
      reviewedAt: null,
      registeredAt: new Date(),
    };
    await user.save();

    return res.status(201).json({ success: true, message: 'Coin seller request submitted. Wait for Super Admin approval.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/coin-seller/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    const user = await User.findOne({ email });
    if (!user || !user.password) return res.status(401).json({ success: false, message: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid email or password' });
    if ((user.accountStatus || 'active') !== 'active') return res.status(403).json({ success: false, message: `Account is ${user.accountStatus}` });
    if (user.coinSellerStatus !== 'approved' && user.role !== 'coin_seller') {
      return res.status(403).json({ success: false, message: `Coin seller request is ${user.coinSellerStatus || 'not approved'}` });
    }

    user.lastLogin = new Date();
    user.role = 'coin_seller';
    user.coinSellerStatus = 'approved';
    user.coinSellerRegistration.status = 'approved';
    await user.save();

    const token = await createOfficialSession(user._id);
    return res.json({ success: true, token, seller: serializeSeller(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/coin-seller/me', requireCoinSeller, async (req, res) => {
  try {
    const seller = await User.findById(req.coinSeller._id).select(sellerProjection).lean();
    return res.json({ success: true, seller });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/coin-seller/transactions', requireCoinSeller, async (req, res) => {
  try {
    const transactions = await CoinSellerTransaction.find({ sellerId: req.coinSeller._id })
      .populate('buyerId', 'name email glixId profilePic')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({ success: true, transactions });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/coin-seller/sell', requireCoinSeller, async (req, res) => {
  try {
    const glixId = String(req.body?.glixId || '').trim();
    const coins = Math.floor(Number(req.body?.coins));
    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!glixId) return res.status(400).json({ success: false, message: 'Buyer Glix ID is required' });
    if (!Number.isFinite(coins) || coins <= 0) return res.status(400).json({ success: false, message: 'Coins must be greater than zero' });

    const seller = await User.findById(req.coinSeller._id);
    if (!seller || seller.coinSellerStatus !== 'approved') return res.status(403).json({ success: false, message: 'Seller is not approved' });
    if ((seller.sellerBalance || 0) < coins) return res.status(400).json({ success: false, message: 'Seller balance is too low' });

    const buyer = await User.findOne({ glixId });
    if (!buyer) return res.status(404).json({ success: false, message: 'Buyer not found by Glix ID' });
    if (String(buyer._id) === String(seller._id)) return res.status(400).json({ success: false, message: 'Seller cannot sell coins to own account' });

    seller.sellerBalance = (seller.sellerBalance || 0) - coins;
    seller.sellerTotalSold = (seller.sellerTotalSold || 0) + coins;
    buyer.chang = (buyer.chang || 0) + coins;

    await Promise.all([seller.save(), buyer.save()]);
    const transaction = await CoinSellerTransaction.create({
      sellerId: seller._id,
      buyerId: buyer._id,
      buyerGlixId: buyer.glixId,
      coins,
      paymentMethod,
      note,
      sellerBalanceAfter: seller.sellerBalance,
      buyerCoinsAfter: buyer.chang,
    });

    return res.json({
      success: true,
      transaction,
      seller: serializeSeller(seller),
      buyer: { id: buyer._id, name: buyer.name, glixId: buyer.glixId, chang: buyer.chang },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/coin-seller/requests', requireOfficial, async (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    const query = status === 'all'
      ? { $or: [{ coinSellerStatus: { $ne: 'none' } }, { 'coinSellerRegistration.status': { $ne: 'none' } }] }
      : { $or: [{ coinSellerStatus: status }, { 'coinSellerRegistration.status': status }] };
    const requests = await User.find(query).select('-password -passwordResetOtpHash').sort({ 'coinSellerRegistration.registeredAt': -1, createdAt: -1 }).lean();
    return res.json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/coin-seller/requests/:userId', requireOfficial, async (req, res) => {
  try {
    const status = ['approved', 'rejected', 'suspended'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, message: 'Invalid coin seller status' });
    const update = {
      role: status === 'approved' ? 'coin_seller' : undefined,
      coinSellerStatus: status,
      coinSellerRejectionReason: status === 'rejected' ? String(req.body?.reason || '') : '',
      'coinSellerRegistration.status': status,
      'coinSellerRegistration.rejectionReason': status === 'rejected' ? String(req.body?.reason || '') : '',
      'coinSellerRegistration.reviewedBy': req.officialUser._id,
      'coinSellerRegistration.reviewedAt': new Date(),
    };
    Object.keys(update).forEach(key => update[key] === undefined && delete update[key]);
    const user = await User.findByIdAndUpdate(req.params.userId, { $set: update }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/coin-sellers', requireOfficial, async (req, res) => {
  try {
    const sellers = await User.find({ $or: [{ coinSellerStatus: { $in: ['approved', 'suspended'] } }, { role: 'coin_seller' }] })
      .select('name email glixId role coinSellerStatus coinSellerRegistration sellerBalance sellerTotalSold createdAt')
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, sellers });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/coin-sellers/:sellerId/balance', requireOfficial, async (req, res) => {
  try {
    const amount = Math.floor(Number(req.body?.amount));
    const type = req.body?.type === 'deduct' ? 'deduct' : 'add';
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: 'Amount must be greater than zero' });
    const seller = await User.findById(req.params.sellerId);
    if (!seller) return res.status(404).json({ success: false, message: 'Seller not found' });
    if (type === 'deduct' && (seller.sellerBalance || 0) < amount) return res.status(400).json({ success: false, message: 'Seller balance is too low' });
    seller.sellerBalance = type === 'deduct' ? (seller.sellerBalance || 0) - amount : (seller.sellerBalance || 0) + amount;
    await seller.save();
    return res.json({ success: true, seller: serializeOfficialUser(seller) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/monthly-commissions', requireOfficial, async (req, res) => {
  try {
    const query = {};
    if (req.query.status && req.query.status !== 'all') query.status = req.query.status;
    if (req.query.month) query.month = String(req.query.month).trim();
    const commissions = await MonthlyCommission.find(query)
      .populate('beneficiaryId', 'name email glixId agencyCode')
      .populate('hostId', 'name email glixId')
      .sort({ month: -1, createdAt: -1 })
      .lean();
    const totals = commissions.reduce((acc, row) => {
      acc.sourceCoins += row.sourceCoins || 0;
      acc.commissionAmount += row.commissionAmount || 0;
      return acc;
    }, { sourceCoins: 0, commissionAmount: 0 });
    return res.json({ success: true, commissions, totals });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

const getFirebaseMessaging = () => {
  try {
    if (!getApps().length) initializeApp();
    return getMessaging();
  } catch (error) {
    return null;
  }
};

app.post('/admin/notifications/send', requireOfficial, async (req, res) => {
  try {
    const target = req.body?.target || 'all';
    const title = String(req.body?.title || 'Glix Live');
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ success: false, message: 'Notification body is required' });

    const query = {};
    if (target === 'hosts') query.hostStatus = 'approved';
    if (target === 'selected') {
      const ids = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
      const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
      query.$or = [
        { _id: { $in: objectIds } },
        { glixId: { $in: ids } },
        { email: { $in: ids.map(item => String(item).toLowerCase()) } },
      ];
    }

    const users = await User.find(query).select('fcmTokens settings').lean();
    const tokens = users.flatMap(user => (
      (user.fcmTokens || [])
        .map(item => item?.token)
        .filter(Boolean)
    ));

    const messaging = getFirebaseMessaging();
    if (!messaging || !tokens.length) {
      return res.json({
        success: true,
        matchedUsers: users.length,
        tokenCount: tokens.length,
        successCount: 0,
        failureCount: 0,
        skippedUsers: !tokens.length ? users.length : 0,
        skippedReasons: !tokens.length ? { no_fcm_token: users.length } : { firebase_not_configured: users.length },
      });
    }

    let successCount = 0;
    let failureCount = 0;
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const result = await messaging.sendEachForMulticast({ tokens: chunk, notification: { title, body }, data: { source: 'official_portal' } });
      successCount += result.successCount || 0;
      failureCount += result.failureCount || 0;
    }

    return res.json({ success: true, matchedUsers: users.length, tokenCount: tokens.length, successCount, failureCount, skippedUsers: 0, skippedReasons: {} });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});










