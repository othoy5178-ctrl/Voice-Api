import 'dotenv/config';
import "./conn.js";
import { Server } from 'socket.io';
import http from 'http';
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import pkg from "agora-token";

import User from "./User.js";
import OfficialUser from "./OfficialUser.js";
import AudioRoom from "./AudioRoom.js";
import Room from "./RoomSchema.js";
import DirectMessage from "./DirectMessage.js";
import Follow from './Follow.js';
import GiftTransaction from './GiftTransation.js';
import GiftCatalog from './GiftCatalog.js';
import RewardActivity from './RewardActivity.js';
import RewardClaim from './RewardClaim.js';
import HostLiveRewardClaim from './HostLiveRewardClaim.js';
import StoreItem from './StoreItem.js';
import UserStoreItem from './UserStoreItem.js';
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import AuthSession from "./AuthSession.js";
import Withdrawal from "./Withdrawal.js";
import MonthlyCommission from "./MonthlyCommission.js";
import DailyCommission from "./DailyCommission.js";
import AgencyTarget from "./AgencyTarget.js";
import CoinSellerTransaction from "./CoinSellerTransaction.js";
import GameCoinTransaction from "./GameCoinTransaction.js";
import ProfileVisit from "./ProfileVisit.js";
import RoomMusicTrack from "./RoomMusicTrack.js";
import DiamondExchange from "./DiamondExchange.js";
import CoinBag from "./CoinBag.js";
import CoinBagClaim from "./CoinBagClaim.js";
import CustomRoomTheme from "./CustomRoomTheme.js";
import { ROOM_BACKGROUND_THEMES } from "./roomBackgroundThemes.js";
import cloudinary from "./utils/cloudinary.js";

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

const roomPresence = {};
const roomControllers = {};
const roomKeepOpenRooms = {};
const roomDisconnectTimers = new Map();
const roomEmptyAudienceTimers = new Map();
const ROOM_RECONNECT_GRACE_MS = Number(process.env.ROOM_RECONNECT_GRACE_MS || 60000);
const KEPT_OPEN_EMPTY_AUDIENCE_GRACE_MS = Number(process.env.KEPT_OPEN_EMPTY_AUDIENCE_GRACE_MS || 30000);
const COIN_BAG_ALLOWED_AMOUNTS = [10000, 30000, 50000, 100000];
const COIN_BAG_ALLOWED_CLAIM_LIMITS = [10, 20, 50];
const COIN_BAG_PLATFORM_FEE_RATE = 0.03;
const COIN_BAG_ACTIVE_MS = 10000;
const CUSTOM_ROOM_THEME_PRICE_COINS = 50000;
const CUSTOM_ROOM_THEME_DURATION_DAYS = 30;
const GIFT_QUANTITY_OPTIONS = [1, 5, 10, 20, 50, 100];
const clampPercent = (value, fallback, max = 100) => {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return fallback;
  return Math.min(Math.max(rate, 0), max);
};
const HOST_GIFT_SHARE_PERCENT = 70;
const AGENCY_COMMISSION_RATE_PERCENT = clampPercent(process.env.AGENCY_COMMISSION_RATE_PERCENT, 4, 20);
const ADMIN_COMMISSION_RATE_PERCENT = clampPercent(process.env.ADMIN_COMMISSION_RATE_PERCENT, 3, 3);
const MANAGER_COMMISSION_RATE_PERCENT = clampPercent(process.env.MANAGER_COMMISSION_RATE_PERCENT, 3, 3);
const AGENCY_COMMISSION_TIERS = [
  { min: 0, max: 17000000, rate: 4 },
  { min: 17000000, max: 70000000, rate: 8 },
  { min: 70000000, max: 130000000, rate: 12 },
  { min: 130000000, max: 200000000, rate: 16 },
  { min: 200000000, max: Infinity, rate: 20 },
];
const LUCKY_GIFT_NAMES = new Set([
  'love burst',
  'dream castle',
  'victory car',
  'ocean pearl',
  'fire phoenix',
  'treasure box',
  'neon party',
]);

const ROOM_SETTING_STRING_FIELDS = [
  'title',
  'coverUrl',
  'description',
  'announcement',
  'welcomeMessage',
  'roomTag',
  'roomPassword',
];
const ROOM_SETTING_BOOLEAN_FIELDS = [
  'automaticSeatInvitation',
  'enablePublicChat',
  'autoEmojiEnabled',
];

const serializeRoomSettings = (room = {}) => ({
  title: room.title || '',
  coverUrl: room.coverUrl || '',
  description: room.description || '',
  announcement: room.announcement || '',
  welcomeMessage: room.welcomeMessage || '',
  roomTag: room.roomTag || '',
  hasPassword: !!room.roomPassword,
  automaticSeatInvitation: room.automaticSeatInvitation !== false,
  enablePublicChat: room.enablePublicChat !== false,
  autoEmojiEnabled: !!room.autoEmojiEnabled,
});

const buildRoomSettingsUpdate = (body = {}) => {
  const updates = {};

  ROOM_SETTING_STRING_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      const maxLength = field === 'title' ? 40 : field === 'roomPassword' ? 24 : 240;
      updates[field] = String(body[field] ?? '').trim().slice(0, maxLength);
    }
  });

  ROOM_SETTING_BOOLEAN_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updates[field] = !!body[field];
    }
  });

  if (updates.title === '') delete updates.title;
  return updates;
};

const roomPasswordMatches = (room = {}, incomingPassword = '') => {
  const savedPassword = String(room?.roomPassword || '').trim();
  if (!savedPassword) return true;
  return String(incomingPassword || '').trim() === savedPassword;
};

const findRoomForSettings = async (roomId) => {
  const stringRoomId = roomId ? roomId.toString() : '';
  if (!stringRoomId) return { room: null, roomMode: '', socketRoomId: '' };

  if (mongoose.Types.ObjectId.isValid(stringRoomId)) {
    const audioRoom = await AudioRoom.findById(stringRoomId);
    if (audioRoom) return { room: audioRoom, roomMode: 'audio', socketRoomId: audioRoom._id.toString() };

    const videoById = await Room.findById(stringRoomId);
    if (videoById) return { room: videoById, roomMode: 'video', socketRoomId: videoById.channelName };
  }

  const videoRoom = await Room.findOne({ channelName: stringRoomId });
  if (videoRoom) return { room: videoRoom, roomMode: 'video', socketRoomId: videoRoom.channelName };

  return { room: null, roomMode: '', socketRoomId: '' };
};

const uploadRoomCoverAsset = async (dataUri, roomId = 'room') => {
  const cleanDataUri = String(dataUri || '').trim();
  if (!cleanDataUri.startsWith('data:image/')) {
    throw new Error('Invalid room cover image.');
  }

  const result = await cloudinary.uploader.upload(cleanDataUri, {
    folder: `room-covers/${roomId}`,
    resource_type: 'image',
    overwrite: false,
    transformation: [
      { width: 1200, height: 680, crop: 'fill', gravity: 'auto', quality: 'auto', fetch_format: 'auto' }
    ],
  });

  return result.secure_url;
};

const buildPermanentAudioRoomTitle = (user = {}) => {
  const name = String(user?.name || '').trim();
  return name ? `${name}'s Room` : 'My Voice Room';
};

const ensurePermanentAudioRoomForUser = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return null;

  const user = await User.findById(userId).select('name profilePic glixId').lean();
  if (!user) return null;

  let room = await AudioRoom.findOne({
    hostId: userId,
    isPermanent: true
  }).sort({ createdAt: 1 });

  if (!room) {
    room = await AudioRoom.create({
      title: buildPermanentAudioRoomTitle(user),
      hostId: userId,
      speakers: [],
      audience: [],
      lockedSlots: [3, 12, 19],
      isPermanent: true,
      visibility: 'followers',
      isLive: false,
      endedAt: null,
      lastHeartbeatAt: new Date()
    });
  }

  return room;
};

const serializePermanentAudioRoom = (room = {}) => {
  const host = room.hostId || {};
  const roomId = room._id?.toString?.() || String(room._id || '');

  return {
    id: roomId,
    _id: roomId,
    roomId,
    roomMode: 'audio',
    title: room.title || buildPermanentAudioRoomTitle(host),
    hostId: host?._id?.toString?.() || room.hostId?.toString?.() || '',
    host: host?._id ? host : null,
    isPermanent: true,
    visibility: room.visibility || 'followers',
    isLive: !!room.isLive,
    speakerCount: Array.isArray(room.speakers) ? room.speakers.length : 0,
    audienceCount: Array.isArray(room.audience) ? room.audience.length : 0,
    createdAt: room.createdAt,
    lastHeartbeatAt: room.lastHeartbeatAt,
  };
};
const LUCKY_GIFT_RETURN_CHANCE_PERCENT = Math.min(100, Math.max(0, Number(process.env.LUCKY_GIFT_RETURN_CHANCE_PERCENT || 10)));
const LUCKY_GIFT_REWARD_MULTIPLIER = Math.max(0, Number(process.env.LUCKY_GIFT_REWARD_MULTIPLIER || 1));
const LEVEL_LAKH_REQUIREMENTS = [
  1, 1, 1, 2, 2, 2, 3, 3, 4, 5,
  6, 7, 8, 9, 10, 12, 14, 16, 18, 20,
  22, 24, 26, 28, 30, 33, 36, 39, 42, 45,
  50, 55, 60, 65, 70, 75, 80, 85, 90, 95,
  100, 110, 120, 130, 140, 150, 160, 170, 180, 190,
  200, 210, 220, 230, 240, 250, 260, 270, 280, 290,
  300, 310, 320, 330, 340, 350, 360, 370, 380, 390,
  400, 410, 420, 430, 440, 450, 460, 470, 480, 490,
  500, 510, 520, 530, 540, 550, 560, 570, 580, 590,
  600, 610, 620, 630, 640, 650, 660, 670, 680, 700,
];
const LEVEL_THRESHOLDS = LEVEL_LAKH_REQUIREMENTS.reduce((thresholds, value) => {
  const previousTotal = thresholds[thresholds.length - 1] || 0;
  thresholds.push(previousTotal + (value * 100000));
  return thresholds;
}, []);
const calculateUserLevelValue = (value = 0) => {
  const total = Math.max(0, Number(value) || 0);
  let level = 1;

  for (let index = 0; index < LEVEL_THRESHOLDS.length; index += 1) {
    if (total >= LEVEL_THRESHOLDS[index]) {
      level = index + 1;
    } else {
      break;
    }
  }

  return level;
};

const getStringRoomId = (roomId) => (roomId ? roomId.toString() : '');
const getRoomDisconnectTimerKey = (roomId, userId) => `${getStringRoomId(roomId)}:${userId?.toString?.() || String(userId || '')}`;
const getRoomEmptyAudienceTimerKey = (roomId) => getStringRoomId(roomId);

const clearRoomDisconnectTimer = (roomId, userId) => {
  const timerKey = getRoomDisconnectTimerKey(roomId, userId);
  const timer = roomDisconnectTimers.get(timerKey);
  if (!timer) return false;
  clearTimeout(timer);
  roomDisconnectTimers.delete(timerKey);
  return true;
};

const clearRoomEmptyAudienceTimer = (roomId) => {
  const timerKey = getRoomEmptyAudienceTimerKey(roomId);
  const timer = roomEmptyAudienceTimers.get(timerKey);
  if (!timer) return false;
  clearTimeout(timer);
  roomEmptyAudienceTimers.delete(timerKey);
  return true;
};

const buildRoomMemberPayload = (userId, fallback = {}) => ({
  userId: userId?.toString?.() || String(userId || ''),
  id: userId?.toString?.() || String(userId || ''),
  socketId: fallback.socketId || null,
  numericUid: fallback.numericUid ?? null,
  name: fallback.name || fallback.username || 'User',
  profilePic: fallback.profilePic || fallback.avatar || '',
  glixId: fallback.glixId || '',
  daimon: fallback.daimon || 0,
  sentGiftCoins: fallback.sentGiftCoins || 0,
  isVip: !!fallback.isVip,
  vipExpiresAt: fallback.vipExpiresAt || null,
  vipBadgeUrl: fallback.vipBadgeUrl || '',
  role: fallback.role || 'audience',
  joinedAt: fallback.joinedAt || Date.now(),
  updatedAt: Date.now(),
});

const emitRoomMembers = (roomId) => {
  const stringRoomId = getStringRoomId(roomId);
  if (!stringRoomId) return;

  const members = Object.values(roomPresence[stringRoomId] || {})
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));

  io.to(stringRoomId).emit('room_members_updated', members);
};

const upsertRoomPresence = async ({ roomId, userId, socketId, name, profilePic, numericUid = null, role = 'audience' }) => {
  const stringRoomId = getStringRoomId(roomId);
  if (!stringRoomId || !userId) return;

  clearRoomEmptyAudienceTimer(stringRoomId);

  const userKey = userId.toString();
  if (!roomPresence[stringRoomId]) roomPresence[stringRoomId] = {};

  const existing = roomPresence[stringRoomId][userKey] || {};
  let dbUser = null;

  if (mongoose.Types.ObjectId.isValid(userKey)) {
    dbUser = await User.findById(userKey)
      .select('name profilePic glixId daimon sentGiftCoins isVip vipExpiresAt vipBadgeUrl')
      .lean();
  }

  roomPresence[stringRoomId][userKey] = buildRoomMemberPayload(userKey, {
    ...existing,
    socketId: socketId || existing.socketId || null,
    numericUid: numericUid ?? existing.numericUid ?? null,
    name: dbUser?.name || name || existing.name || 'User',
    profilePic: dbUser?.profilePic || profilePic || existing.profilePic || '',
    glixId: dbUser?.glixId || existing.glixId || '',
    daimon: dbUser?.daimon ?? existing.daimon ?? 0,
    sentGiftCoins: dbUser?.sentGiftCoins ?? existing.sentGiftCoins ?? 0,
    isVip: dbUser?.isVip ?? existing.isVip ?? false,
    vipExpiresAt: dbUser?.vipExpiresAt || existing.vipExpiresAt || null,
    vipBadgeUrl: dbUser?.vipBadgeUrl || existing.vipBadgeUrl || '',
    role: role || existing.role || 'audience',
    joinedAt: existing.joinedAt || Date.now(),
  });

  emitRoomMembers(stringRoomId);
};

const removeRoomPresence = ({ roomId, userId, socketId }) => {
  const stringRoomId = getStringRoomId(roomId);
  if (!stringRoomId || !roomPresence[stringRoomId]) return;

  const userKey = userId ? userId.toString() : null;
  if (userKey && roomPresence[stringRoomId][userKey]) {
    const memberSocketId = roomPresence[stringRoomId][userKey].socketId;
    if (!socketId || !memberSocketId || memberSocketId === socketId) {
      delete roomPresence[stringRoomId][userKey];
    }
  } else if (socketId) {
    const matchingEntry = Object.entries(roomPresence[stringRoomId]).find(([, member]) => member.socketId === socketId);
    if (matchingEntry) delete roomPresence[stringRoomId][matchingEntry[0]];
  }

  if (!Object.keys(roomPresence[stringRoomId]).length) {
    delete roomPresence[stringRoomId];
  }

  emitRoomMembers(stringRoomId);
};

const closeKeptOpenAudioRoomIfNoAudience = async (roomId, reason = 'empty_audience') => {
  const stringRoomId = getStringRoomId(roomId);
  if (!stringRoomId || stringRoomId.startsWith('glix_') || !roomKeepOpenRooms[stringRoomId]) return false;
  if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return false;

  const room = await AudioRoom.findById(stringRoomId).select('hostId isLive speakers audience createdAt');
  if (!room || !room.isLive) return false;

  const hostId = room.hostId ? room.hostId.toString() : '';
  const livePresenceUsers = Object.values(roomPresence[stringRoomId] || {})
    .filter(member => member?.id && String(member.id) !== hostId);
  const dbAudience = Array.isArray(room.audience)
    ? room.audience.filter(userId => userId && String(userId) !== hostId)
    : [];
  const dbSpeakers = Array.isArray(room.speakers)
    ? room.speakers.filter(speaker => speaker?.userId && String(speaker.userId) !== hostId)
    : [];

  if (livePresenceUsers.length || dbAudience.length || dbSpeakers.length) return false;

  room.isLive = false;
  room.speakers = [];
  room.audience = [];
  room.endedAt = new Date();
  await room.save();

  clearRoomEmptyAudienceTimer(stringRoomId);
  delete roomKeepOpenRooms[stringRoomId];
  delete roomControllers[stringRoomId];
  delete roomPresence[stringRoomId];

  io.to(stringRoomId).emit('room_members_updated', []);
  io.to(stringRoomId).emit('audio_room_ended', {
    reason,
    message: 'The voice room closed because no audience is left.'
  });

  console.log(`Kept-open audio room closed because no audience is left: ${stringRoomId}`);
  return true;
};

const scheduleKeptOpenAudioRoomEmptyCheck = (roomId, reason = 'empty_audience') => {
  const stringRoomId = getStringRoomId(roomId);
  if (!stringRoomId || stringRoomId.startsWith('glix_') || !roomKeepOpenRooms[stringRoomId]) return false;
  if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return false;

  clearRoomEmptyAudienceTimer(stringRoomId);

  const timer = setTimeout(async () => {
    roomEmptyAudienceTimers.delete(stringRoomId);
    try {
      await closeKeptOpenAudioRoomIfNoAudience(stringRoomId, reason);
    } catch (error) {
      console.log('Delayed kept-open audio room empty check error:', error);
    }
  }, KEPT_OPEN_EMPTY_AUDIENCE_GRACE_MS);

  roomEmptyAudienceTimers.set(stringRoomId, timer);
  return true;
};

const LIVE_ROOM_STALE_MS = 5 * 60 * 1000;

const getLiveRoomFreshCutoff = () => new Date(Date.now() - LIVE_ROOM_STALE_MS);

const getVideoRoomFilter = (roomId) => {
  const stringRoomId = roomId ? roomId.toString() : '';
  if (!stringRoomId) return null;
  if (stringRoomId.startsWith('glix_')) return { channelName: stringRoomId };
  if (mongoose.Types.ObjectId.isValid(stringRoomId)) return { _id: stringRoomId };
  return null;
};

const resolveAgoraRoomChannel = async (roomId) => {
  const stringRoomId = roomId ? roomId.toString() : '';
  if (!stringRoomId) return null;

  const videoFilter = getVideoRoomFilter(stringRoomId);
  if (videoFilter) {
    const videoRoom = await Room.findOne(videoFilter).select('_id channelName hostId').lean();
    if (videoRoom?.channelName) {
      return {
        room: videoRoom,
        roomMode: 'video',
        channelName: videoRoom.channelName,
        canonicalRoomId: videoRoom.channelName,
      };
    }
  }

  if (mongoose.Types.ObjectId.isValid(stringRoomId)) {
    const audioRoom = await AudioRoom.findById(stringRoomId).select('_id hostId').lean();
    if (audioRoom?._id) {
      return {
        room: audioRoom,
        roomMode: 'audio',
        channelName: audioRoom._id.toString(),
        canonicalRoomId: audioRoom._id.toString(),
      };
    }
  }

  return null;
};

const closeStaleLiveRooms = async () => {
  const cutoff = getLiveRoomFreshCutoff();
  const now = new Date();
  const staleFilter = {
    isLive: true,
    $or: [
      { lastHeartbeatAt: { $lt: cutoff } },
      { lastHeartbeatAt: { $exists: false }, createdAt: { $lt: cutoff } }
    ]
  };

  const [staleAudioRooms, staleVideoRooms] = await Promise.all([
    AudioRoom.find(staleFilter).select('_id hostId createdAt').lean(),
    Room.find(staleFilter).select('_id channelName hostId createdAt').lean()
  ]);

  await Promise.all([
    ...staleVideoRooms.map(room => recordHostLiveSessionActivity({
      hostId: room.hostId,
      roomId: room.channelName || room._id,
      roomMode: 'video',
      startedAt: room.createdAt,
      endedAt: now
    }))
  ]);

  await Promise.all([
    AudioRoom.updateMany(staleFilter, { $set: { isLive: false, speakers: [], audience: [], endedAt: now } }),
    Room.updateMany(staleFilter, { $set: { isLive: false, endedAt: now } })
  ]);
};

const createCleanSlotsBlueprint = () => Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  locked: i === 3 || i === 12 || i === 19,
  userId: null,
  uid: null,
  username: `${i + 1}`,
  avatar: null,
  isMuted: false
}));

const buildRoomSlotsSnapshot = async (roomId) => {
  const stringRoomId = getStringRoomId(roomId);
  if (!stringRoomId) return null;

  const slots = createCleanSlotsBlueprint();
  const isVideoRoom = stringRoomId.startsWith('glix_');

  if (isVideoRoom) {
    const videoRoomDoc = await Room.findOne({ channelName: stringRoomId }).select('slots').lean();
    return Array.isArray(videoRoomDoc?.slots) ? videoRoomDoc.slots : slots;
  }

  if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return slots;

  const audioRoomDoc = await AudioRoom.findById(stringRoomId)
    .populate('speakers.userId', 'name profilePic frameUrl')
    .select('speakers micSeatCount micLayoutType backgroundThemeId backgroundThemeUrl lockedSlots')
    .lean();

  if (!audioRoomDoc) return null;

  const lockedSlots = new Set((audioRoomDoc.lockedSlots || [3, 12, 19]).map(Number));
  (audioRoomDoc.speakers || []).filter(speaker => speaker && speaker.userId).forEach(speaker => {
    const index = Number(speaker.slotIndex);
    if (index >= 0 && index < slots.length) {
      slots[index] = {
        ...slots[index],
        locked: lockedSlots.has(index),
        userId: speaker.userId?._id?.toString?.() || speaker.userId?.toString?.() || null,
        uid: speaker.numericUid || null,
        username: speaker.userId?.name || 'Broadcaster',
        avatar: speaker.userId?.profilePic || null,
        frameUrl: speaker.frameUrl || speaker.userId?.frameUrl || null,
        isMuted: !!speaker.isMuted,
      };
    }
  });

  return {
    slots: slots.map((slot, index) => ({ ...slot, locked: lockedSlots.has(index) })),
    micSeatCount: audioRoomDoc.micSeatCount || 15,
    micLayoutType: audioRoomDoc.micLayoutType || 'chatroom',
    backgroundThemeId: audioRoomDoc.backgroundThemeId || null,
    backgroundThemeUrl: audioRoomDoc.backgroundThemeUrl || null,
  };
};

const emitRoomSlotsSnapshot = async (roomId) => {
  const stringRoomId = getStringRoomId(roomId);
  if (!stringRoomId) return;

  const snapshot = await buildRoomSlotsSnapshot(stringRoomId);
  if (snapshot) io.to(stringRoomId).emit('room_slots_updated', snapshot);
};

const getAudioMicSlotFailure = async (roomId, userId, slotIndex) => {
  const room = await AudioRoom.findById(roomId).select('isLive micSeatCount lockedSlots speakers').lean();
  if (!room || !room.isLive) return { status: 404, message: 'Audio room is not available.' };
  if (slotIndex >= Number(room.micSeatCount || 15)) {
    return { status: 400, message: 'Mic slot is outside this room layout.' };
  }

  const lockedSlots = (room.lockedSlots || []).map(Number);
  const existingSlotSpeaker = (room.speakers || []).find(speaker => Number(speaker?.slotIndex) === slotIndex);
  const isSameSpeaker = existingSlotSpeaker?.userId && String(existingSlotSpeaker.userId) === String(userId);

  if (lockedSlots.includes(slotIndex) && !isSameSpeaker) {
    return { status: 423, message: 'This mic slot is locked.' };
  }
  if (existingSlotSpeaker?.userId && !isSameSpeaker) {
    return { status: 409, message: 'This mic slot is already occupied.' };
  }
  return { status: 409, message: 'Mic slot could not be reserved. Please try again.' };
};

const reserveAudioMicSlot = async ({ roomId, userId, slotIndex, numericUid, isMuted = false, frameUrl = null }) => {
  const normalizedSlotIndex = Number(slotIndex);
  const sanitizedUid = parseInt(numericUid, 10) || 0;
  if (!mongoose.Types.ObjectId.isValid(roomId) || !mongoose.Types.ObjectId.isValid(userId)) {
    return { ok: false, status: 400, message: 'Invalid mic slot request.' };
  }
  if (!Number.isInteger(normalizedSlotIndex) || normalizedSlotIndex < 0 || !sanitizedUid) {
    return { ok: false, status: 400, message: 'Invalid mic slot selected.' };
  }

  const roomObjectId = new mongoose.Types.ObjectId(roomId);
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const now = new Date();

  const room = await AudioRoom.findOneAndUpdate(
    {
      _id: roomObjectId,
      isLive: true,
      micSeatCount: { $gt: normalizedSlotIndex },
      $and: [
        {
          $or: [
            { lockedSlots: { $ne: normalizedSlotIndex } },
            { speakers: { $elemMatch: { slotIndex: normalizedSlotIndex, userId: userObjectId } } },
            ...(normalizedSlotIndex === 0 ? [{ hostId: userObjectId }] : [])
          ]
        },
        {
          speakers: {
            $not: {
              $elemMatch: {
                slotIndex: normalizedSlotIndex,
                userId: { $ne: userObjectId }
              }
            }
          }
        }
      ]
    },
    [
      {
        $set: {
          speakers: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ['$speakers', []] },
                  as: 'speaker',
                  cond: { $ne: ['$$speaker.userId', userObjectId] }
                }
              },
              [{
                userId: userObjectId,
                slotIndex: normalizedSlotIndex,
                numericUid: sanitizedUid,
                isMuted: !!isMuted,
                frameUrl: frameUrl || null
              }]
            ]
          },
          audience: {
            $filter: {
              input: { $ifNull: ['$audience', []] },
              as: 'audienceUserId',
              cond: { $ne: ['$$audienceUserId', userObjectId] }
            }
          },
          lastHeartbeatAt: now
        }
      }
    ],
    {
      new: true,
      projection: 'lockedSlots speakers hostId micSeatCount'
    }
  ).lean();

  if (!room) {
    const failure = await getAudioMicSlotFailure(roomObjectId, userObjectId, normalizedSlotIndex);
    return { ok: false, ...failure };
  }

  return {
    ok: true,
    room,
    locked: (room.lockedSlots || []).map(Number).includes(normalizedSlotIndex)
  };
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
  { itemKey: 'star_entry_effect', name: 'Star Entry', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 300, currency: 'chang', durationDays: 30, assetKey: 'star', previewUrl: 'https://www.w3schools.com/html/mov_bbb.mp4', equipValue: 'https://www.w3schools.com/html/mov_bbb.mp4', sortOrder: 9 },
  { itemKey: 'svip_1', name: 'SVIP 1', category: 'VIP', section: 'SVIP', type: 'vip', price: 200000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108929/35_utcpg1.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108929/35_utcpg1.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741464/done_eqmjjk.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741464/done_eqmjjk.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628813/8_os4dp2.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628813/8_os4dp2.mp4', sortOrder: 10 },
  { itemKey: 'svip_2', name: 'SVIP 2', category: 'VIP', section: 'SVIP', type: 'vip', price: 500000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108950/10_mmjbai.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108950/10_mmjbai.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741466/done_3_b9domq.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741466/done_3_b9domq.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628810/7_qis4xg.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628810/7_qis4xg.mp4', sortOrder: 11 },
  { itemKey: 'svip_3', name: 'SVIP 3', category: 'VIP', section: 'SVIP', type: 'vip', price: 12000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108934/28_tmosll.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108934/28_tmosll.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741462/done_2_piyvt0.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741462/done_2_piyvt0.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628807/4_sjysf9.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628807/4_sjysf9.mp4', sortOrder: 12 },
  { itemKey: 'svip_4', name: 'SVIP 4', category: 'VIP', section: 'SVIP', type: 'vip', price: 30000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108946/6_ssrx8b.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108946/6_ssrx8b.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741462/done_4_p2jcp2.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741462/done_4_p2jcp2.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628804/3_kuirjc.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628804/3_kuirjc.mp4', sortOrder: 13 },
  { itemKey: 'svip_5', name: 'SVIP 5', category: 'VIP', section: 'SVIP', type: 'vip', price: 62000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108939/29_xfhzbc.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108939/29_xfhzbc.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741466/done_5_omnirb.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741466/done_5_omnirb.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628802/9_nsjreq.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628802/9_nsjreq.mp4', sortOrder: 14 },
  { itemKey: 'svip_6', name: 'SVIP 6', category: 'VIP', section: 'SVIP', type: 'vip', price: 128000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108936/21_ulfv20.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108936/21_ulfv20.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741460/done_6_bvgbgd.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741460/done_6_bvgbgd.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628798/5_zkxwyt.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628798/5_zkxwyt.mp4', sortOrder: 15 },
  { itemKey: 'svip_7', name: 'SVIP 7', category: 'VIP', section: 'SVIP', type: 'vip', price: 250000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108924/41_ql13et.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108924/41_ql13et.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741457/done_7_rtyzfj.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741457/done_7_rtyzfj.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628795/10_go1g0k.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628795/10_go1g0k.mp4', sortOrder: 16 },
  { itemKey: 'svip_8', name: 'SVIP 8', category: 'VIP', section: 'SVIP', type: 'vip', price: 6000000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108923/43_wodtmf.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108923/43_wodtmf.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741459/done_8_pefnco.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741459/done_8_pefnco.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628793/2_lm7ttu.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628793/2_lm7ttu.mp4', sortOrder: 17 },
  { itemKey: 'svip_9', name: 'SVIP 9', category: 'VIP', section: 'SVIP', type: 'vip', price: 12000000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108925/44_xbrrvf.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108925/44_xbrrvf.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741464/done_9_ve38js.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741464/done_9_ve38js.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628789/6_ewzmzk.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628789/6_ewzmzk.mp4', sortOrder: 18 },
  { itemKey: 'svip_10', name: 'SVIP 10', category: 'VIP', section: 'SVIP', type: 'vip', price: 25000000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108928/40_ovz5gx.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108928/40_ovz5gx.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741457/done_10_ceo0r3.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741457/done_10_ceo0r3.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628786/14_bshtzf.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628786/14_bshtzf.mp4', sortOrder: 19 },
  { itemKey: 'svip_11', name: 'SVIP 11', category: 'VIP', section: 'SVIP', type: 'vip', price: 50000000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108932/32_aqy1oy.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108932/32_aqy1oy.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741455/done_11_cgwyo5.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741455/done_11_cgwyo5.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628783/12_tegcpr.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628783/12_tegcpr.mp4', sortOrder: 20 },
  { itemKey: 'svip_12', name: 'SVIP 12', category: 'VIP', section: 'SVIP', type: 'vip', price: 100000000000, currency: 'chang', durationDays: 30, isVipItem: true, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108925/42_aorxmf.gif', badgeUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784108925/42_aorxmf.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741455/no_lt4rqq.gif', frameUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784741455/no_lt4rqq.gif', entryImageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628781/11_ruumbr.jpg', entryVideoUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628781/11_ruumbr.mp4', sortOrder: 21 },
  { itemKey: 'cloud_frame_14_k1gmdn', name: 'Frame 14', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627198/14_k1gmdn.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627198/14_k1gmdn.png', sortOrder: 100 },
  { itemKey: 'cloud_frame_38_pntuoi', name: 'Frame 38', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627195/38_pntuoi.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627195/38_pntuoi.png', sortOrder: 101 },
  { itemKey: 'cloud_frame_47_qbtd4b', name: 'Frame 47', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627193/47_qbtd4b.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627193/47_qbtd4b.png', sortOrder: 102 },
  { itemKey: 'cloud_frame_32_zh3kmk', name: 'Frame 32', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627190/32_zh3kmk.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627190/32_zh3kmk.png', sortOrder: 103 },
  { itemKey: 'cloud_frame_33_visry2', name: 'Frame 33', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627188/33_visry2.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627188/33_visry2.png', sortOrder: 104 },
  { itemKey: 'cloud_frame_57_bbqxz0', name: 'Frame 57', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627186/57_bbqxz0.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627186/57_bbqxz0.png', sortOrder: 105 },
  { itemKey: 'cloud_frame_35_aovwsn', name: 'Frame 35', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627183/35_aovwsn.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627183/35_aovwsn.png', sortOrder: 106 },
  { itemKey: 'cloud_frame_49_g810qd', name: 'Frame 49', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627181/49_g810qd.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627181/49_g810qd.png', sortOrder: 107 },
  { itemKey: 'cloud_frame_23_uiuhvl', name: 'Frame 23', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627179/23_uiuhvl.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627179/23_uiuhvl.png', sortOrder: 108 },
  { itemKey: 'cloud_frame_7_drllix', name: 'Frame 7', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627176/7_drllix.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627176/7_drllix.png', sortOrder: 109 },
  { itemKey: 'cloud_frame_58_ys0ajn', name: 'Frame 58', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627174/58_ys0ajn.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627174/58_ys0ajn.png', sortOrder: 110 },
  { itemKey: 'cloud_frame_16_phjlxp', name: 'Frame 16', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627172/16_phjlxp.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627172/16_phjlxp.png', sortOrder: 111 },
  { itemKey: 'cloud_frame_44_h68nnq', name: 'Frame 44', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627169/44_h68nnq.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627169/44_h68nnq.png', sortOrder: 112 },
  { itemKey: 'cloud_frame_20_fwncwv', name: 'Frame 20', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627168/20_fwncwv.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627168/20_fwncwv.png', sortOrder: 113 },
  { itemKey: 'cloud_frame_65_usa7l3', name: 'Frame 65', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627165/65_usa7l3.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627165/65_usa7l3.png', sortOrder: 114 },
  { itemKey: 'cloud_frame_54_qyvwe9', name: 'Frame 54', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627163/54_qyvwe9.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627163/54_qyvwe9.png', sortOrder: 115 },
  { itemKey: 'cloud_frame_31_kebioh', name: 'Frame 31', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627160/31_kebioh.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627160/31_kebioh.png', sortOrder: 116 },
  { itemKey: 'cloud_frame_34_oivgv0', name: 'Frame 34', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627158/34_oivgv0.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627158/34_oivgv0.png', sortOrder: 117 },
  { itemKey: 'cloud_frame_24_gf1wdd', name: 'Frame 24', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627156/24_gf1wdd.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627156/24_gf1wdd.png', sortOrder: 118 },
  { itemKey: 'cloud_frame_9_jthu2n', name: 'Frame 9', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627153/9_jthu2n.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627153/9_jthu2n.png', sortOrder: 119 },
  { itemKey: 'cloud_frame_6_tauyyr', name: 'Frame 6', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627151/6_tauyyr.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627151/6_tauyyr.png', sortOrder: 120 },
  { itemKey: 'cloud_frame_4_bugdbb', name: 'Frame 4', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627148/4_bugdbb.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627148/4_bugdbb.png', sortOrder: 121 },
  { itemKey: 'cloud_frame_40_bwqyid', name: 'Frame 40', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627146/40_bwqyid.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627146/40_bwqyid.png', sortOrder: 122 },
  { itemKey: 'cloud_frame_48_eyhoe2', name: 'Frame 48', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627143/48_eyhoe2.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627143/48_eyhoe2.png', sortOrder: 123 },
  { itemKey: 'cloud_frame_37_tgx4nf', name: 'Frame 37', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627141/37_tgx4nf.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627141/37_tgx4nf.png', sortOrder: 124 },
  { itemKey: 'cloud_frame_41_ar50r1', name: 'Frame 41', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627139/41_ar50r1.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627139/41_ar50r1.png', sortOrder: 125 },
  { itemKey: 'cloud_frame_13_abmekr', name: 'Frame 13', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627136/13_abmekr.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627136/13_abmekr.png', sortOrder: 126 },
  { itemKey: 'cloud_frame_52_ezcqqv', name: 'Frame 52', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627134/52_ezcqqv.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627134/52_ezcqqv.png', sortOrder: 127 },
  { itemKey: 'cloud_frame_43_jhm00v', name: 'Frame 43', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627132/43_jhm00v.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627132/43_jhm00v.png', sortOrder: 128 },
  { itemKey: 'cloud_frame_36_ejk5w0', name: 'Frame 36', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627129/36_ejk5w0.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627129/36_ejk5w0.png', sortOrder: 129 },
  { itemKey: 'cloud_frame_45_pfojqu', name: 'Frame 45', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627127/45_pfojqu.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627127/45_pfojqu.png', sortOrder: 130 },
  { itemKey: 'cloud_frame_8_uxettd', name: 'Frame 8', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627125/8_uxettd.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627125/8_uxettd.png', sortOrder: 131 },
  { itemKey: 'cloud_frame_63_sz3ztd', name: 'Frame 63', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627122/63_sz3ztd.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627122/63_sz3ztd.png', sortOrder: 132 },
  { itemKey: 'cloud_frame_22_wbfpsi', name: 'Frame 22', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627120/22_wbfpsi.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627120/22_wbfpsi.png', sortOrder: 133 },
  { itemKey: 'cloud_frame_17_gqiw6z', name: 'Frame 17', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627117/17_gqiw6z.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627117/17_gqiw6z.png', sortOrder: 134 },
  { itemKey: 'cloud_frame_66_hmmpsp', name: 'Frame 66', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627115/66_hmmpsp.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627115/66_hmmpsp.png', sortOrder: 135 },
  { itemKey: 'cloud_frame_1_v1sv8x', name: 'Frame 1', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627113/1_v1sv8x.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627113/1_v1sv8x.png', sortOrder: 136 },
  { itemKey: 'cloud_frame_62_urwcf4', name: 'Frame 62', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627110/62_urwcf4.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627110/62_urwcf4.png', sortOrder: 137 },
  { itemKey: 'cloud_frame_46_ghipag', name: 'Frame 46', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627108/46_ghipag.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627108/46_ghipag.png', sortOrder: 138 },
  { itemKey: 'cloud_frame_51_ebhwbv', name: 'Frame 51', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627106/51_ebhwbv.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627106/51_ebhwbv.png', sortOrder: 139 },
  { itemKey: 'cloud_frame_10_f4wba6', name: 'Frame 10', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627103/10_f4wba6.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627103/10_f4wba6.png', sortOrder: 140 },
  { itemKey: 'cloud_frame_3_tgjc8u', name: 'Frame 3', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627101/3_tgjc8u.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627101/3_tgjc8u.png', sortOrder: 141 },
  { itemKey: 'cloud_frame_26_pvys8p', name: 'Frame 26', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627098/26_pvys8p.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627098/26_pvys8p.png', sortOrder: 142 },
  { itemKey: 'cloud_frame_5_xq2z8v', name: 'Frame 5', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627096/5_xq2z8v.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627096/5_xq2z8v.png', sortOrder: 143 },
  { itemKey: 'cloud_frame_42_xyzjem', name: 'Frame 42', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627094/42_xyzjem.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627094/42_xyzjem.png', sortOrder: 144 },
  { itemKey: 'cloud_frame_39_vypjvj', name: 'Frame 39', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627092/39_vypjvj.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627092/39_vypjvj.png', sortOrder: 145 },
  { itemKey: 'cloud_frame_12_urmvjq', name: 'Frame 12', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627090/12_urmvjq.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627090/12_urmvjq.png', sortOrder: 146 },
  { itemKey: 'cloud_frame_55_mltnjg', name: 'Frame 55', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627087/55_mltnjg.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627087/55_mltnjg.png', sortOrder: 147 },
  { itemKey: 'cloud_frame_56_vbqjiz', name: 'Frame 56', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627085/56_vbqjiz.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627085/56_vbqjiz.png', sortOrder: 148 },
  { itemKey: 'cloud_frame_11_hrjjum', name: 'Frame 11', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627082/11_hrjjum.png', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784627082/11_hrjjum.png', sortOrder: 149 },
  { itemKey: 'cloud_frame_9_h2evxz', name: 'Frame 9', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628310/9_h2evxz.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628310/9_h2evxz.gif', sortOrder: 150 },
  { itemKey: 'cloud_frame_12_vag6bt', name: 'Frame 12', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628302/12_vag6bt.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628302/12_vag6bt.gif', sortOrder: 151 },
  { itemKey: 'cloud_frame_17_nukvoq', name: 'Frame 17', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628298/17_nukvoq.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628298/17_nukvoq.gif', sortOrder: 152 },
  { itemKey: 'cloud_frame_13_rphrxk', name: 'Frame 13', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628296/13_rphrxk.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628296/13_rphrxk.gif', sortOrder: 153 },
  { itemKey: 'cloud_frame_6_tvddud', name: 'Frame 6', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628285/6_tvddud.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628285/6_tvddud.gif', sortOrder: 154 },
  { itemKey: 'cloud_frame_15_rlma2f', name: 'Frame 15', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628283/15_rlma2f.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628283/15_rlma2f.gif', sortOrder: 155 },
  { itemKey: 'cloud_frame_18_dzx27i', name: 'Frame 18', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628278/18_dzx27i.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628278/18_dzx27i.gif', sortOrder: 156 },
  { itemKey: 'cloud_frame_19_rybkoo', name: 'Frame 19', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628275/19_rybkoo.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628275/19_rybkoo.gif', sortOrder: 157 },
  { itemKey: 'cloud_frame_16_mocxnk', name: 'Frame 16', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628272/16_mocxnk.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628272/16_mocxnk.gif', sortOrder: 158 },
  { itemKey: 'cloud_frame_20_vd0egw', name: 'Frame 20', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628271/20_vd0egw.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628271/20_vd0egw.gif', sortOrder: 159 },
  { itemKey: 'cloud_frame_26_umkve5', name: 'Frame 26', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628267/26_umkve5.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628267/26_umkve5.gif', sortOrder: 160 },
  { itemKey: 'cloud_frame_14_q6pyqs', name: 'Frame 14', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628265/14_q6pyqs.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628265/14_q6pyqs.gif', sortOrder: 161 },
  { itemKey: 'cloud_frame_29_esxjer', name: 'Frame 29', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628259/29_esxjer.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628259/29_esxjer.gif', sortOrder: 162 },
  { itemKey: 'cloud_frame_22_onf3px', name: 'Frame 22', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628255/22_onf3px.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628255/22_onf3px.gif', sortOrder: 163 },
  { itemKey: 'cloud_frame_24_rxgxej', name: 'Frame 24', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628251/24_rxgxej.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628251/24_rxgxej.gif', sortOrder: 164 },
  { itemKey: 'cloud_frame_30_igwcaf', name: 'Frame 30', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628249/30_igwcaf.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628249/30_igwcaf.gif', sortOrder: 165 },
  { itemKey: 'cloud_frame_25_duv6o3', name: 'Frame 25', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628246/25_duv6o3.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628246/25_duv6o3.gif', sortOrder: 166 },
  { itemKey: 'cloud_frame_23_bodmmy', name: 'Frame 23', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628243/23_bodmmy.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628243/23_bodmmy.gif', sortOrder: 167 },
  { itemKey: 'cloud_frame_21_tfjjq2', name: 'Frame 21', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628241/21_tfjjq2.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628241/21_tfjjq2.gif', sortOrder: 168 },
  { itemKey: 'cloud_frame_28_hrh0lr', name: 'Frame 28', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628238/28_hrh0lr.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628238/28_hrh0lr.gif', sortOrder: 169 },
  { itemKey: 'cloud_frame_38_yjlorr', name: 'Frame 38', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628236/38_yjlorr.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628236/38_yjlorr.gif', sortOrder: 170 },
  { itemKey: 'cloud_frame_32_fnd3su', name: 'Frame 32', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628233/32_fnd3su.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628233/32_fnd3su.gif', sortOrder: 171 },
  { itemKey: 'cloud_frame_36_izzfk0', name: 'Frame 36', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628230/36_izzfk0.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628230/36_izzfk0.gif', sortOrder: 172 },
  { itemKey: 'cloud_frame_31_wyyda4', name: 'Frame 31', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628194/31_wyyda4.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628194/31_wyyda4.gif', sortOrder: 173 },
  { itemKey: 'cloud_frame_39_ls1tup', name: 'Frame 39', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628179/39_ls1tup.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628179/39_ls1tup.gif', sortOrder: 174 },
  { itemKey: 'cloud_frame_40_fcexaj', name: 'Frame 40', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628176/40_fcexaj.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628176/40_fcexaj.gif', sortOrder: 175 },
  { itemKey: 'cloud_frame_35_si0buy', name: 'Frame 35', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628174/35_si0buy.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628174/35_si0buy.gif', sortOrder: 176 },
  { itemKey: 'cloud_frame_34_yf6z9a', name: 'Frame 34', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628171/34_yf6z9a.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628171/34_yf6z9a.gif', sortOrder: 177 },
  { itemKey: 'cloud_frame_37_tb0zcm', name: 'Frame 37', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628168/37_tb0zcm.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628168/37_tb0zcm.gif', sortOrder: 178 },
  { itemKey: 'cloud_frame_44_ebbeb9', name: 'Frame 44', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628164/44_ebbeb9.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628164/44_ebbeb9.gif', sortOrder: 179 },
  { itemKey: 'cloud_frame_41_v65wiv', name: 'Frame 41', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628160/41_v65wiv.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628160/41_v65wiv.gif', sortOrder: 180 },
  { itemKey: 'cloud_frame_43_lmtxpm', name: 'Frame 43', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628158/43_lmtxpm.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628158/43_lmtxpm.gif', sortOrder: 181 },
  { itemKey: 'cloud_frame_49_fa0qeh', name: 'Frame 49', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628155/49_fa0qeh.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628155/49_fa0qeh.gif', sortOrder: 182 },
  { itemKey: 'cloud_frame_45_cayuhy', name: 'Frame 45', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628152/45_cayuhy.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628152/45_cayuhy.gif', sortOrder: 183 },
  { itemKey: 'cloud_frame_42_r1ouqe', name: 'Frame 42', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628147/42_r1ouqe.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628147/42_r1ouqe.gif', sortOrder: 184 },
  { itemKey: 'cloud_frame_48_d9uemy', name: 'Frame 48', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628144/48_d9uemy.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628144/48_d9uemy.gif', sortOrder: 185 },
  { itemKey: 'cloud_frame_50_u40kel', name: 'Frame 50', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628141/50_u40kel.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628141/50_u40kel.gif', sortOrder: 186 },
  { itemKey: 'cloud_frame_46_gdgjgo', name: 'Frame 46', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628139/46_gdgjgo.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628139/46_gdgjgo.gif', sortOrder: 187 },
  { itemKey: 'cloud_frame_52_biifh8', name: 'Frame 52', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628136/52_biifh8.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628136/52_biifh8.gif', sortOrder: 188 },
  { itemKey: 'cloud_frame_53_o5xfy9', name: 'Frame 53', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628134/53_o5xfy9.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628134/53_o5xfy9.gif', sortOrder: 189 },
  { itemKey: 'cloud_frame_58_jtz5nz', name: 'Frame 58', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628131/58_jtz5nz.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628131/58_jtz5nz.gif', sortOrder: 190 },
  { itemKey: 'cloud_frame_54_xvxxnl', name: 'Frame 54', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628128/54_xvxxnl.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628128/54_xvxxnl.gif', sortOrder: 191 },
  { itemKey: 'cloud_frame_57_oa3jne', name: 'Frame 57', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628126/57_oa3jne.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628126/57_oa3jne.gif', sortOrder: 192 },
  { itemKey: 'cloud_frame_51_cqjbyu', name: 'Frame 51', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628123/51_cqjbyu.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628123/51_cqjbyu.gif', sortOrder: 193 },
  { itemKey: 'cloud_frame_56_czjl1m', name: 'Frame 56', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628120/56_czjl1m.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628120/56_czjl1m.gif', sortOrder: 194 },
  { itemKey: 'cloud_frame_55_mdytd2', name: 'Frame 55', category: 'Profile', section: 'Avatar Frame', type: 'frame', price: 29.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628118/55_mdytd2.gif', equipValue: 'https://res.cloudinary.com/dh99ihggv/image/upload/v1784628118/55_mdytd2.gif', sortOrder: 195 },
  { itemKey: 'cloud_entry_8_os4dp2', name: 'Entry 8', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628813/8_os4dp2.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628813/8_os4dp2.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628813/8_os4dp2.mp4', sortOrder: 200 },
  { itemKey: 'cloud_entry_7_qis4xg', name: 'Entry 7', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628810/7_qis4xg.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628810/7_qis4xg.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628810/7_qis4xg.mp4', sortOrder: 201 },
  { itemKey: 'cloud_entry_4_sjysf9', name: 'Entry 4', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628807/4_sjysf9.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628807/4_sjysf9.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628807/4_sjysf9.mp4', sortOrder: 202 },
  { itemKey: 'cloud_entry_3_kuirjc', name: 'Entry 3', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628804/3_kuirjc.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628804/3_kuirjc.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628804/3_kuirjc.mp4', sortOrder: 203 },
  { itemKey: 'cloud_entry_9_nsjreq', name: 'Entry 9', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628802/9_nsjreq.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628802/9_nsjreq.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628802/9_nsjreq.mp4', sortOrder: 204 },
  { itemKey: 'cloud_entry_5_zkxwyt', name: 'Entry 5', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628798/5_zkxwyt.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628798/5_zkxwyt.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628798/5_zkxwyt.mp4', sortOrder: 205 },
  { itemKey: 'cloud_entry_10_go1g0k', name: 'Entry 10', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628795/10_go1g0k.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628795/10_go1g0k.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628795/10_go1g0k.mp4', sortOrder: 206 },
  { itemKey: 'cloud_entry_2_lm7ttu', name: 'Entry 2', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628793/2_lm7ttu.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628793/2_lm7ttu.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628793/2_lm7ttu.mp4', sortOrder: 207 },
  { itemKey: 'cloud_entry_6_ewzmzk', name: 'Entry 6', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628789/6_ewzmzk.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628789/6_ewzmzk.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628789/6_ewzmzk.mp4', sortOrder: 208 },
  { itemKey: 'cloud_entry_14_bshtzf', name: 'Entry 14', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628786/14_bshtzf.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628786/14_bshtzf.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628786/14_bshtzf.mp4', sortOrder: 209 },
  { itemKey: 'cloud_entry_12_tegcpr', name: 'Entry 12', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628783/12_tegcpr.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628783/12_tegcpr.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628783/12_tegcpr.mp4', sortOrder: 210 },
  { itemKey: 'cloud_entry_11_ruumbr', name: 'Entry 11', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628781/11_ruumbr.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628781/11_ruumbr.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628781/11_ruumbr.mp4', sortOrder: 211 },
  { itemKey: 'cloud_entry_13_xughgs', name: 'Entry 13', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628777/13_xughgs.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628777/13_xughgs.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628777/13_xughgs.mp4', sortOrder: 212 },
  { itemKey: 'cloud_entry_15_p7deus', name: 'Entry 15', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628774/15_p7deus.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628774/15_p7deus.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628774/15_p7deus.mp4', sortOrder: 213 },
  { itemKey: 'cloud_entry_20_byzqpf', name: 'Entry 20', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628771/20_byzqpf.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628771/20_byzqpf.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628771/20_byzqpf.mp4', sortOrder: 214 },
  { itemKey: 'cloud_entry_19_rxxu1l', name: 'Entry 19', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628769/19_rxxu1l.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628769/19_rxxu1l.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628769/19_rxxu1l.mp4', sortOrder: 215 },
  { itemKey: 'cloud_entry_17_eebwqe', name: 'Entry 17', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628766/17_eebwqe.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628766/17_eebwqe.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628766/17_eebwqe.mp4', sortOrder: 216 },
  { itemKey: 'cloud_entry_18_ohpphx', name: 'Entry 18', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628763/18_ohpphx.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628763/18_ohpphx.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628763/18_ohpphx.mp4', sortOrder: 217 },
  { itemKey: 'cloud_entry_16_z4apof', name: 'Entry 16', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628760/16_z4apof.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628760/16_z4apof.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628760/16_z4apof.mp4', sortOrder: 218 },
  { itemKey: 'cloud_entry_21_kbwsuu', name: 'Entry 21', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628757/21_kbwsuu.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628757/21_kbwsuu.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628757/21_kbwsuu.mp4', sortOrder: 219 },
  { itemKey: 'cloud_entry_25_ne8xig', name: 'Entry 25', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628754/25_ne8xig.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628754/25_ne8xig.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628754/25_ne8xig.mp4', sortOrder: 220 },
  { itemKey: 'cloud_entry_22_duzzmz', name: 'Entry 22', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628751/22_duzzmz.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628751/22_duzzmz.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628751/22_duzzmz.mp4', sortOrder: 221 },
  { itemKey: 'cloud_entry_24_lzgj9n', name: 'Entry 24', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628748/24_lzgj9n.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628748/24_lzgj9n.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628748/24_lzgj9n.mp4', sortOrder: 222 },
  { itemKey: 'cloud_entry_23_u9xnu1', name: 'Entry 23', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628745/23_u9xnu1.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628745/23_u9xnu1.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628745/23_u9xnu1.mp4', sortOrder: 223 },
  { itemKey: 'cloud_entry_26_lp6zp8', name: 'Entry 26', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628742/26_lp6zp8.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628742/26_lp6zp8.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628742/26_lp6zp8.mp4', sortOrder: 224 },
  { itemKey: 'cloud_entry_27_xuvmuk', name: 'Entry 27', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628740/27_xuvmuk.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628740/27_xuvmuk.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628740/27_xuvmuk.mp4', sortOrder: 225 },
  { itemKey: 'cloud_entry_29_hfktut', name: 'Entry 29', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628737/29_hfktut.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628737/29_hfktut.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628737/29_hfktut.mp4', sortOrder: 226 },
  { itemKey: 'cloud_entry_30_yabjdq', name: 'Entry 30', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628733/30_yabjdq.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628733/30_yabjdq.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628733/30_yabjdq.mp4', sortOrder: 227 },
  { itemKey: 'cloud_entry_31_c6kipl', name: 'Entry 31', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628731/31_c6kipl.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628731/31_c6kipl.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628731/31_c6kipl.mp4', sortOrder: 228 },
  { itemKey: 'cloud_entry_32_f8s3hd', name: 'Entry 32', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628728/32_f8s3hd.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628728/32_f8s3hd.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628728/32_f8s3hd.mp4', sortOrder: 229 },
  { itemKey: 'cloud_entry_33_bee8pw', name: 'Entry 33', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628726/33_bee8pw.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628726/33_bee8pw.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628726/33_bee8pw.mp4', sortOrder: 230 },
  { itemKey: 'cloud_entry_38_tsvnqs', name: 'Entry 38', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628722/38_tsvnqs.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628722/38_tsvnqs.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628722/38_tsvnqs.mp4', sortOrder: 231 },
  { itemKey: 'cloud_entry_35_uwyjvo', name: 'Entry 35', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628720/35_uwyjvo.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628720/35_uwyjvo.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628720/35_uwyjvo.mp4', sortOrder: 232 },
  { itemKey: 'cloud_entry_34_gkcmgl', name: 'Entry 34', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628717/34_gkcmgl.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628717/34_gkcmgl.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628717/34_gkcmgl.mp4', sortOrder: 233 },
  { itemKey: 'cloud_entry_37_gwhje6', name: 'Entry 37', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628713/37_gwhje6.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628713/37_gwhje6.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628713/37_gwhje6.mp4', sortOrder: 234 },
  { itemKey: 'cloud_entry_36_rlkbxr', name: 'Entry 36', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628711/36_rlkbxr.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628711/36_rlkbxr.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628711/36_rlkbxr.mp4', sortOrder: 235 },
  { itemKey: 'cloud_entry_43_gg6duk', name: 'Entry 43', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628707/43_gg6duk.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628707/43_gg6duk.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628707/43_gg6duk.mp4', sortOrder: 236 },
  { itemKey: 'cloud_entry_41_inqp5q', name: 'Entry 41', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628705/41_inqp5q.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628705/41_inqp5q.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628705/41_inqp5q.mp4', sortOrder: 237 },
  { itemKey: 'cloud_entry_40_yjgir5', name: 'Entry 40', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628702/40_yjgir5.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628702/40_yjgir5.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628702/40_yjgir5.mp4', sortOrder: 238 },
  { itemKey: 'cloud_entry_39_e9fl8v', name: 'Entry 39', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628699/39_e9fl8v.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628699/39_e9fl8v.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628699/39_e9fl8v.mp4', sortOrder: 239 },
  { itemKey: 'cloud_entry_42_y4pnu2', name: 'Entry 42', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628696/42_y4pnu2.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628696/42_y4pnu2.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628696/42_y4pnu2.mp4', sortOrder: 240 },
  { itemKey: 'cloud_entry_46_v6sr3g', name: 'Entry 46', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628693/46_v6sr3g.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628693/46_v6sr3g.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628693/46_v6sr3g.mp4', sortOrder: 241 },
  { itemKey: 'cloud_entry_44_tj7ctv', name: 'Entry 44', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628690/44_tj7ctv.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628690/44_tj7ctv.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628690/44_tj7ctv.mp4', sortOrder: 242 },
  { itemKey: 'cloud_entry_47_jbzd6i', name: 'Entry 47', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628687/47_jbzd6i.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628687/47_jbzd6i.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628687/47_jbzd6i.mp4', sortOrder: 243 },
  { itemKey: 'cloud_entry_45_tdy5p0', name: 'Entry 45', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628685/45_tdy5p0.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628685/45_tdy5p0.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628685/45_tdy5p0.mp4', sortOrder: 244 },
  { itemKey: 'cloud_entry_51_fp1jq4', name: 'Entry 51', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628682/51_fp1jq4.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628682/51_fp1jq4.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628682/51_fp1jq4.mp4', sortOrder: 245 },
  { itemKey: 'cloud_entry_50_e4ryit', name: 'Entry 50', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628678/50_e4ryit.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628678/50_e4ryit.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628678/50_e4ryit.mp4', sortOrder: 246 },
  { itemKey: 'cloud_entry_49_kskvcy', name: 'Entry 49', category: 'Popular', section: 'New This Month', type: 'entryVideo', price: 99.99, currency: 'chang', durationDays: 30, imageUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/h_250,q_auto/v1784628676/49_kskvcy.jpg', previewUrl: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628676/49_kskvcy.mp4', equipValue: 'https://res.cloudinary.com/dh99ihggv/video/upload/v1784628676/49_kskvcy.mp4', sortOrder: 247 }
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
  const user = await User.findById(userId).select('daimon chang frameUrl entryVideoUrl isVip vipExpiresAt vipBadgeUrl vipItemKey');
  if (!user) return null;
  return {
    daimon: user.daimon || 0,
    chang: user.chang || 0,
    frameUrl: user.frameUrl || '',
    entryVideoUrl: user.entryVideoUrl || '',
    isVip: !!user.isVip,
    vipExpiresAt: user.vipExpiresAt || null,
    vipBadgeUrl: user.vipBadgeUrl || '',
    vipItemKey: user.vipItemKey || ''
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
  },
  {
    key: 'new_host_live_hour',
    category: 'Host',
    title: 'New host live bonus',
    description: 'Stream for 60 minutes as a new host to claim 5,000 coins. Available twice per day for your first 7 host days.',
    target: 60,
    amount: 5000,
    rewardType: 'chang',
    activityTypes: ['host_live_session'],
    action: 'start_live'
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
const NEW_HOST_LIVE_REWARD_KEY = 'new_host_live_hour';
const NEW_HOST_LIVE_REWARD_DAYS = 7;
const NEW_HOST_LIVE_REWARD_MINUTES = 60;
const NEW_HOST_LIVE_REWARD_DAILY_LIMIT = 2;
const NEW_HOST_LIVE_REWARD_AMOUNT = 5000;

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

const recordHostLiveSessionActivity = async ({ hostId, roomId, roomMode, startedAt, endedAt = new Date() }) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(hostId) || !roomId || !startedAt) return;
    if (roomMode !== 'video') return;

    const startDate = new Date(startedAt);
    const endDate = new Date(endedAt);
    const durationMinutes = Math.max(0, Math.floor((endDate.getTime() - startDate.getTime()) / 60000));
    if (durationMinutes <= 0) return;

    const existing = await RewardActivity.findOne({
      userId: hostId,
      type: 'host_live_session',
      'metadata.roomId': roomId.toString()
    }).select('_id');

    if (existing) return;

    await RewardActivity.create({
      userId: hostId,
      type: 'host_live_session',
      metadata: {
        roomId: roomId.toString(),
        roomMode,
        startedAt: startDate,
        endedAt: endDate,
        durationMinutes
      },
      createdAt: endDate
    });
  } catch (error) {
    console.warn(`Host live reward session skipped: ${error.message}`);
  }
};

const getRewardProgress = async (userId, task, start, end) => {
  if (task.key === 'daily_check_in') return 1;
  if (task.key === NEW_HOST_LIVE_REWARD_KEY) return 0;
  return RewardActivity.countDocuments({
    userId,
    type: { $in: task.activityTypes },
    createdAt: { $gte: start, $lt: end }
  });
};

const getNewHostRewardEligibility = (user, now = new Date()) => {
  const hostApproved =
    user?.hostStatus === 'approved' ||
    user?.hostRegistration?.status === 'approved' ||
    user?.role === 'host' ||
    user?.role === 'super_admin';

  const hostStartAt = user?.hostRegistration?.reviewedAt ||
    user?.hostRegistration?.registeredAt ||
    user?.createdAt ||
    null;

  if (!hostApproved || !hostStartAt) {
    return {
      eligible: false,
      hostApproved,
      hostStartAt,
      expiresAt: null,
      daysLeft: 0,
      reason: hostApproved ? 'Host start date missing' : 'Only approved hosts can claim this reward'
    };
  }

  const startDate = new Date(hostStartAt);
  const expiresAt = new Date(startDate.getTime() + (NEW_HOST_LIVE_REWARD_DAYS * 24 * 60 * 60 * 1000));
  const eligible = now < expiresAt;
  const daysLeft = eligible ? Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))) : 0;

  return {
    eligible,
    hostApproved,
    hostStartAt: startDate,
    expiresAt,
    daysLeft,
    reason: eligible ? '' : 'New host live bonus has expired'
  };
};

const getActiveHostedMinutesToday = async (userId, start, now = new Date()) => {
  const videoRooms = await Room.find({ hostId: userId.toString(), isLive: true, createdAt: { $lt: now } }).select('createdAt').lean();

  return videoRooms.reduce((total, room) => {
    const liveStart = new Date(Math.max(new Date(room.createdAt).getTime(), start.getTime()));
    const minutes = Math.max(0, Math.floor((now.getTime() - liveStart.getTime()) / 60000));
    return total + minutes;
  }, 0);
};

const getNewHostLiveRewardStatus = async (user, start, end, dayKey, now = new Date()) => {
  const task = REWARD_TASKS.find(item => item.key === NEW_HOST_LIVE_REWARD_KEY);
  const eligibility = getNewHostRewardEligibility(user, now);
  const userObjectId = new mongoose.Types.ObjectId(user._id);

  const [sessionAgg, activeMinutes, claimsToday] = await Promise.all([
    RewardActivity.aggregate([
      {
        $match: {
          userId: userObjectId,
          type: 'host_live_session',
          'metadata.roomMode': 'video',
          createdAt: { $gte: start, $lt: end }
        }
      },
      {
        $group: {
          _id: null,
          totalMinutes: { $sum: { $ifNull: ['$metadata.durationMinutes', 0] } }
        }
      }
    ]),
    getActiveHostedMinutesToday(user._id, start, now),
    HostLiveRewardClaim.countDocuments({ hostId: user._id, dayKey })
  ]);

  const recordedMinutes = Math.floor(sessionAgg?.[0]?.totalMinutes || 0);
  const totalMinutesToday = recordedMinutes + activeMinutes;
  const completedHourBlocks = Math.floor(totalMinutesToday / NEW_HOST_LIVE_REWARD_MINUTES);
  const cappedCompletedBlocks = Math.min(completedHourBlocks, NEW_HOST_LIVE_REWARD_DAILY_LIMIT);
  const availableClaims = Math.max(0, cappedCompletedBlocks - claimsToday);
  const dailyLimitReached = claimsToday >= NEW_HOST_LIVE_REWARD_DAILY_LIMIT;
  const canClaim = eligibility.eligible && availableClaims > 0 && !dailyLimitReached;
  const nextProgress = canClaim
    ? NEW_HOST_LIVE_REWARD_MINUTES
    : dailyLimitReached
      ? NEW_HOST_LIVE_REWARD_MINUTES
      : Math.min(totalMinutesToday % NEW_HOST_LIVE_REWARD_MINUTES, NEW_HOST_LIVE_REWARD_MINUTES);

  return {
    ...task,
    progress: nextProgress,
    totalMinutesToday,
    completedHourBlocks,
    claimsToday,
    maxClaimsPerDay: NEW_HOST_LIVE_REWARD_DAILY_LIMIT,
    claimed: dailyLimitReached,
    canClaim,
    daysLeft: eligibility.daysLeft,
    expiresAt: eligibility.expiresAt?.toISOString?.() || null,
    eligible: eligibility.eligible,
    description: eligibility.eligible
      ? `Host a video live for 60 minutes to claim 5,000 coins. You can claim ${NEW_HOST_LIVE_REWARD_DAILY_LIMIT} times per day.`
      : eligibility.reason
  };
};

const buildRewardDashboard = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    const error = new Error('Invalid user id');
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findById(userId).select('daimon chang name glixId role createdAt hostStatus hostRegistration');
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

  const newHostLiveRewardStatus = await getNewHostLiveRewardStatus(user, start, end, dayKey, now);
  const tasks = await Promise.all(REWARD_TASKS.map(async task => {
    if (task.key === NEW_HOST_LIVE_REWARD_KEY) return newHostLiveRewardStatus;

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

const resolveGiftRoomHostId = async (roomId) => {
  const stringRoomId = roomId ? roomId.toString() : '';
  if (!stringRoomId) return null;

  if (stringRoomId.startsWith('glix_')) {
    const videoRoom = await Room.findOne(getVideoRoomFilter(stringRoomId)).select('hostId').lean();
    return videoRoom?.hostId?.toString?.() || String(videoRoom?.hostId || '') || null;
  }

  if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return null;

  const audioRoom = await AudioRoom.findById(stringRoomId).select('hostId').lean();
  return audioRoom?.hostId?.toString?.() || String(audioRoom?.hostId || '') || null;
};

const resolveCoinBagRoom = async (roomId) => {
  const stringRoomId = roomId ? roomId.toString() : '';
  if (!stringRoomId) return null;

  if (stringRoomId.startsWith('glix_')) {
    const videoRoom = await Room.findOne(getVideoRoomFilter(stringRoomId)).select('_id channelName hostId title isLive').lean();
    if (!videoRoom || videoRoom.isLive === false) return null;
    return {
      roomId: videoRoom.channelName,
      roomType: 'video',
      hostId: videoRoom.hostId?.toString?.() || String(videoRoom.hostId || ''),
      title: videoRoom.title || 'Video Room',
    };
  }

  if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return null;

  const audioRoom = await AudioRoom.findById(stringRoomId).select('_id hostId title isLive').lean();
  if (!audioRoom || audioRoom.isLive === false) return null;

  return {
    roomId: audioRoom._id.toString(),
    roomType: 'voice',
    hostId: audioRoom.hostId?.toString?.() || String(audioRoom.hostId || ''),
    title: audioRoom.title || 'Voice Room',
  };
};

const serializeCoinBag = (bag, extra = {}) => ({
  id: bag._id?.toString?.() || String(bag._id || ''),
  coinBagId: bag._id?.toString?.() || String(bag._id || ''),
  creatorId: bag.creatorId?.toString?.() || String(bag.creatorId || ''),
  roomId: bag.roomId,
  roomType: bag.roomType,
  roomTitle: bag.roomTitle || '',
  totalCoins: bag.totalCoins || 0,
  platformFeeCoins: bag.platformFeeCoins || 0,
  claimableCoins: bag.claimableCoins || 0,
  claimLimit: bag.claimLimit || 0,
  claimAmount: bag.claimAmount || 0,
  remainingClaims: bag.remainingClaims || 0,
  undistributedCoins: bag.undistributedCoins || 0,
  remainingCoins: bag.remainingCoins || 0,
  status: bag.status || 'active',
  expiresAt: bag.expiresAt,
  createdAt: bag.createdAt,
  ...extra,
});

const getHostRoomIdMatchValues = async (hostObjectId) => {
  const hostId = hostObjectId.toString();
  const [audioRooms, videoRooms] = await Promise.all([
    AudioRoom.find({ hostId: hostObjectId }).select('_id').lean(),
    Room.find({ hostId }).select('_id channelName').lean()
  ]);

  const seen = new Set();
  const values = [];
  const addValue = (value) => {
    if (!value) return;
    const key = value.toString();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(value);
    if (typeof value !== 'string') values.push(key);
  };

  audioRooms.forEach(room => addValue(room._id));
  videoRooms.forEach(room => {
    addValue(room.channelName);
    addValue(room._id);
  });

  return values;
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

const getUserSocketRoom = (userId) => `user:${String(userId || '').trim()}`;

const joinUserSocketRoom = (socket, userId) => {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) return false;
  activeUsers[cleanUserId] = socket.id;
  socket.userId = cleanUserId;
  return true;
};

const joinAuthenticatedUserSocketRoom = async (socket, payload = {}) => {
  const cleanUserId = String(payload?.userId || payload?.uid || '').trim();
  const token = String(payload?.token || payload?.authToken || '').trim();
  if (!mongoose.Types.ObjectId.isValid(cleanUserId) || !token) return false;

  const session = await AuthSession.findOne({
    userId: cleanUserId,
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() },
  }).select('_id').lean();

  if (!session) return false;
  socket.join(getUserSocketRoom(cleanUserId));
  joinUserSocketRoom(socket, cleanUserId);
  return true;
};

const emitWalletUpdated = (userId, wallet = {}) => {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) return;
  const payload = {
    userId: cleanUserId,
    source: wallet.source || 'wallet',
    updatedAt: new Date().toISOString(),
  };
  if (wallet.chang !== undefined) payload.chang = Math.max(0, Math.floor(Number(wallet.chang || 0)));
  if (wallet.daimon !== undefined) payload.daimon = Math.max(0, Math.floor(Number(wallet.daimon || 0)));
  if (wallet.commissionBalance !== undefined) payload.commissionBalance = Math.max(0, Math.floor(Number(wallet.commissionBalance || 0)));
  if (wallet.revenueBalance !== undefined) payload.revenueBalance = Math.max(0, Math.floor(Number(wallet.revenueBalance || 0)));
  io.to(getUserSocketRoom(cleanUserId)).emit('wallet_updated', payload);
};

const emitCommissionUpdated = async (beneficiaryId, payload = {}) => {
  const cleanUserId = String(beneficiaryId || '').trim();
  if (!cleanUserId || !mongoose.Types.ObjectId.isValid(cleanUserId)) return;

  const user = await User.findById(cleanUserId)
    .select('commissionBalance revenueBalance totalHostCoins')
    .lean();
  if (!user) return;

  const eventPayload = {
    userId: cleanUserId,
    beneficiaryRole: payload.beneficiaryRole || payload.role || '',
    hostId: payload.hostId ? String(payload.hostId) : '',
    sourceCoins: Math.max(0, Math.floor(Number(payload.sourceCoins || 0))),
    commissionAmount: Math.max(0, Math.floor(Number(payload.commissionAmount || 0))),
    ratePercent: Number(payload.ratePercent || 0),
    month: payload.month || getCommissionMonthKey(),
    day: payload.day || getCommissionDayKey(),
    commissionBalance: Math.max(0, Math.floor(Number(user.commissionBalance || 0))),
    revenueBalance: Math.max(0, Math.floor(Number(user.revenueBalance || 0))),
    totalHostCoins: Math.max(0, Math.floor(Number(user.totalHostCoins || 0))),
    source: 'commission',
    updatedAt: new Date().toISOString(),
  };

  io.to(getUserSocketRoom(cleanUserId)).emit('commission_updated', eventPayload);
  emitWalletUpdated(cleanUserId, eventPayload);
};

io.on('connection', (socket) => {
  console.log(`User connected to socket cluster: ${socket.id}`);

  // 1. EVENT: Join Room
  socket.on('join_audio_room', async ({ roomId, userId, name, profilePic, entryVideoUrl }) => {
    try {
      await clearExpiredStoreItems(userId);
      const userData = await User.findById(userId).select('name profilePic frameUrl entryVideoUrl daimon sentGiftCoins');
      const finalJoinName = userData?.name || name || 'User';
      const finalJoinProfilePic = userData?.profilePic || profilePic || '';
      const frameUrl = userData?.frameUrl || null;
      const joinerSentGiftCoins = Number(userData?.sentGiftCoins || 0);
      const joinerLevel = calculateUserLevelValue(joinerSentGiftCoins);

      const stringRoomId = roomId ? roomId.toString() : '';
      socket.join(stringRoomId);
      socket.roomId = stringRoomId;
      joinUserSocketRoom(socket, userId);
      socket.userName = finalJoinName;

      if (clearRoomDisconnectTimer(stringRoomId, userId)) {
        io.to(stringRoomId).emit('host_reconnected', {
          userId,
          message: `${finalJoinName || 'Host'} reconnected.`
        });
      }

      await upsertRoomPresence({
        roomId: stringRoomId,
        userId,
        socketId: socket.id,
        name: finalJoinName,
        profilePic: finalJoinProfilePic,
        role: stringRoomId.startsWith('glix_') ? 'video' : 'audience'
      });

      // Map connection instance to verify host mappings directly on requests.

      const isVideoRoom = stringRoomId.startsWith('glix_');
      let joinedRoomHostId = '';

      if (isVideoRoom) {
        const videoRoom = await Room.findOne(getVideoRoomFilter(stringRoomId)).select('hostId').lean();
        joinedRoomHostId = videoRoom?.hostId?.toString?.() || String(videoRoom?.hostId || '');
      } else if (mongoose.Types.ObjectId.isValid(stringRoomId)) {
        const audioRoom = await AudioRoom.findById(stringRoomId).select('hostId').lean();
        joinedRoomHostId = audioRoom?.hostId?.toString?.() || String(audioRoom?.hostId || '');
      }

      const isJoiningRoomHost = joinedRoomHostId && String(joinedRoomHostId) === String(userId || '');
      if (isJoiningRoomHost && roomKeepOpenRooms[stringRoomId]) {
        delete roomKeepOpenRooms[stringRoomId];
        delete roomControllers[stringRoomId];
        clearRoomEmptyAudienceTimer(stringRoomId);

        io.to(stringRoomId).emit('host_control_restored', {
          roomId: stringRoomId,
          hostId: joinedRoomHostId,
          userId,
          message: `${finalJoinName || 'Host'} is back. Host control restored.`,
        });
        io.to(stringRoomId).emit('host_reconnected', {
          roomId: stringRoomId,
          hostId: joinedRoomHostId,
          userId,
          message: `${finalJoinName || 'Host'} reconnected.`,
        });
      }

      console.log(`${finalJoinName} joined real-time room channel: ${stringRoomId}`);

      const finalEntryVideoUrl = userData?.entryVideoUrl || entryVideoUrl || null;

      socket.to(stringRoomId).emit('user_joined_channel', {
        userId,
        name: finalJoinName,
        profilePic: finalJoinProfilePic,
        avatar: finalJoinProfilePic,
        avatarUrl: finalJoinProfilePic,
        entryVideoUrl: finalEntryVideoUrl,
        frameUrl: frameUrl || null,
        daimon: joinerDaimon,
        level: joinerLevel,
        user: {
          daimon: joinerDaimon,
          level: joinerLevel
        },
        message: `${finalJoinName} entered the room.`
      });

      if (finalEntryVideoUrl) {
        socket.emit('play_my_own_entry_effect', { entryVideoUrl: finalEntryVideoUrl });
      }

      let completeLayoutMatrix = createCleanSlotsBlueprint();

      if (isVideoRoom) {
        const videoRoomDoc = await Room.findOne({ channelName: stringRoomId });
        if (videoRoomDoc && videoRoomDoc.slots) {
          completeLayoutMatrix = videoRoomDoc.slots;
        }
      } else {
        if (mongoose.Types.ObjectId.isValid(stringRoomId)) {
          const audioRoomDoc = await AudioRoom.findById(stringRoomId).populate('speakers.userId', 'name profilePic frameUrl');
          if (audioRoomDoc && audioRoomDoc.speakers) {
            audioRoomDoc.speakers.filter(speaker => speaker && speaker.userId).forEach(speaker => {
              const index = speaker.slotIndex;
              if (index >= 0 && index < 25) {
                completeLayoutMatrix[index] = {
                  ...completeLayoutMatrix[index],
                  userId: speaker.userId?._id?.toString?.() || speaker.userId?.toString?.() || null,
                  uid: speaker.numericUid || null,
                  username: speaker.userId?.name || "Broadcaster",
                  avatar: speaker.userId?.profilePic || null,
                  frameUrl: speaker.frameUrl || speaker.userId?.frameUrl || null,
                  isMuted: speaker.isMuted || false
                };
              }
            });
          }
        }
      }

      if (isVideoRoom) {
        socket.emit('initialize_room_slots', completeLayoutMatrix);
      } else if (mongoose.Types.ObjectId.isValid(stringRoomId)) {
        const audioRoomLayout = await AudioRoom.findById(stringRoomId).select('micSeatCount micLayoutType backgroundThemeId backgroundThemeUrl lockedSlots').lean();
        const storedLockedSlots = Array.isArray(audioRoomLayout?.lockedSlots) ? audioRoomLayout.lockedSlots : [3, 12, 19];
        const lockedSlots = new Set(storedLockedSlots.map(Number));
        socket.emit('initialize_room_slots', {
          slots: completeLayoutMatrix.map((slot, index) => ({ ...slot, locked: lockedSlots.has(index) })),
          micSeatCount: audioRoomLayout?.micSeatCount || 15,
          micLayoutType: audioRoomLayout?.micLayoutType || 'chatroom',
          backgroundThemeId: audioRoomLayout?.backgroundThemeId || null,
          backgroundThemeUrl: audioRoomLayout?.backgroundThemeUrl || null,
        });
      } else {
        socket.emit('initialize_room_slots', completeLayoutMatrix);
      }
      await emitRoomStats(stringRoomId);

    } catch (err) {
      console.log("Error inside join initialization workflow logic: ", err);
    }
  });

  // 2. EVENT: Request Slot Change
  socket.on('request_slot_change', async ({ roomId, userId, name, profilePic, frameUrl, targetSlotIndex, numericUid, isMuted, cameraOn, locked, slotLocked }) => {
    try {

      let finalFrameUrl = frameUrl;

      // Fetch from DB only if the client didn't send a frameUrl
      if (!finalFrameUrl && userId && typeof locked !== 'boolean') {
        const dbUser = await User.findById(userId).select('frameUrl');
        finalFrameUrl = dbUser?.frameUrl || null;
      }

      const stringRoomId = roomId ? roomId.toString() : '';
      const isVideoRoom = stringRoomId.startsWith('glix_');
      const normalizedSlotIndex = Number(targetSlotIndex);
      const isClearingSlotPayload = profilePic === null || numericUid === null || numericUid === undefined;
      if (!Number.isInteger(normalizedSlotIndex) || normalizedSlotIndex < 0) return;
      if (process.env.NODE_ENV !== 'production') {
        console.log('[VoiceRoom SlotChange]', {
          roomId: stringRoomId,
          userId,
          socketUserId: socket.userId,
          slotIndex: normalizedSlotIndex,
          numericUid,
          isClearing: isClearingSlotPayload,
          locked,
          slotLocked,
        });
      }
      const isLockOnlyRequest = (
        typeof locked === 'boolean' &&
        slotLocked === undefined &&
        name === undefined &&
        profilePic === undefined &&
        frameUrl === undefined &&
        numericUid === undefined &&
        isMuted === undefined &&
        cameraOn === undefined
      );
      let emittedSlotLocked = typeof slotLocked === 'boolean' ? slotLocked : (typeof locked === 'boolean' ? locked : undefined);

      if (isLockOnlyRequest) {
        if (isVideoRoom) {
          socket.emit('error_notice', { message: 'Video slots cannot be locked from this action.' });
          return;
        }

        if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return;
        const audioRoom = await AudioRoom.findById(stringRoomId).select('hostId lockedSlots');
        if (!audioRoom) {
          socket.emit('error_notice', { message: 'Audio room not found.' });
          return;
        }

        const canLockSlot = String(audioRoom.hostId || '') === String(userId || '') || String(audioRoom.hostId || '') === String(socket.userId || '');
        if (!canLockSlot) {
          socket.emit('error_notice', { message: 'Only the host can lock mic slots.' });
          return;
        }

        const lockedSlots = new Set((audioRoom.lockedSlots || []).map(Number));
        if (locked) {
          lockedSlots.add(normalizedSlotIndex);
        } else {
          lockedSlots.delete(normalizedSlotIndex);
        }
        audioRoom.lockedSlots = Array.from(lockedSlots).filter(Number.isInteger).sort((a, b) => a - b);
        audioRoom.lastHeartbeatAt = new Date();
        await audioRoom.save();

        io.to(stringRoomId).emit('slot_lock_changed', {
          slotIndex: normalizedSlotIndex,
          locked
        });
        return;
      }

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
          const isClearingHostSlot = isClearingSlotPayload;

          if (!isRoomHost || isClearingHostSlot) {
            socket.emit('error_notice', { message: 'The first video slot is reserved for the room creator.' });
            return;
          }
        }

        const updateData = profilePic === null
          ? {
            "slots.$.userId": null,
            "slots.$.uid": null,
            "slots.$.username": normalizedSlotIndex === 0 ? 'Main Host' : `Co-Host ${normalizedSlotIndex + 1}`,
            "slots.$.avatar": null,
            "slots.$.frameUrl": null,
            "slots.$.isMuted": false,
            "slots.$.cameraOn": normalizedSlotIndex === 0
          }
          : {
            "slots.$.userId": userId || null,
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

        const isTakingOrUpdatingSeat = profilePic !== null && numericUid !== null && numericUid !== undefined;

        if (!isTakingOrUpdatingSeat) {
          const latestAudioRoom = await AudioRoom.findOneAndUpdate(
            queryFilter,
            {
              $pull: { speakers: { slotIndex: normalizedSlotIndex } },
              $set: { lastHeartbeatAt: new Date() }
            },
            { new: true, projection: 'lockedSlots' }
          ).lean();
          emittedSlotLocked = (latestAudioRoom?.lockedSlots || []).map(Number).includes(normalizedSlotIndex);
        } else {
          const reservation = await reserveAudioMicSlot({
            roomId: stringRoomId,
            userId,
            slotIndex: normalizedSlotIndex,
            numericUid,
            isMuted,
            frameUrl: finalFrameUrl
          });

          if (!reservation.ok) {
            if (process.env.NODE_ENV !== 'production') {
              console.log('[VoiceRoom SlotChange] reservation blocked', {
                roomId: stringRoomId,
                userId,
                slotIndex: normalizedSlotIndex,
                status: reservation.status,
                message: reservation.message,
              });
            }
            socket.emit('error_notice', { message: reservation.message });
            await emitRoomSlotsSnapshot(stringRoomId);
            return;
          }
          emittedSlotLocked = reservation.locked;
        }
      }

      if (!isClearingSlotPayload) {
        await upsertRoomPresence({
          roomId: stringRoomId,
          userId,
          socketId: activeUsers[userId?.toString?.()] || socket.id,
          name,
          profilePic,
          numericUid: numericUid !== null && numericUid !== undefined ? parseInt(numericUid, 10) : null,
          role: isVideoRoom ? (normalizedSlotIndex === 0 ? 'host' : 'cohost') : 'speaker'
        });
      }

      io.to(stringRoomId).emit('slot_state_changed', {
        slotIndex: normalizedSlotIndex,
        user: {
          uid: !isClearingSlotPayload && numericUid ? parseInt(numericUid, 10) : null,
          userId: !isClearingSlotPayload ? userId : null,
          username: !isClearingSlotPayload ? name : null,
          avatar: !isClearingSlotPayload ? profilePic : null,
          frameUrl: !isClearingSlotPayload ? finalFrameUrl : null,
          isMuted: !isClearingSlotPayload ? isMuted || false : false,
          locked: emittedSlotLocked,
          cameraOn: !!cameraOn
        }
      });
      await emitRoomSlotsSnapshot(stringRoomId);

    } catch (error) {
      console.log("Socket array persistence exception error:", error);
      socket.emit('error_notice', { message: 'Failed to synchronize layout seat state.' });
    }
  });

  const handleKeepRoomOpen = async (payload = {}) => {
    try {
      const stringRoomId = getStringRoomId(payload.roomId);
      if (!stringRoomId) return;

      const controller = payload.controller || null;
      const controllerUserId = payload.transferToUserId || payload.toUserId || controller?.userId || controller?.id || controller?._id || null;
      const controllerUid = payload.transferToUid ?? payload.toUid ?? controller?.uid ?? controller?.numericUid ?? null;
      const requesterId = payload.userId || payload.fromUserId || socket.userId || null;
      const isVideoRoom = stringRoomId.startsWith('glix_');

      roomKeepOpenRooms[stringRoomId] = {
        userId: requesterId ? requesterId.toString() : null,
        controllerUserId: controllerUserId ? controllerUserId.toString() : null,
        controllerUid,
        roomMode: isVideoRoom ? 'video' : 'audio',
        updatedAt: Date.now(),
      };

      if (controllerUserId || controllerUid !== null) {
        roomControllers[stringRoomId] = {
          ...(controller || {}),
          userId: controllerUserId,
          uid: controllerUid,
        };
      }

      if (requesterId) clearRoomDisconnectTimer(stringRoomId, requesterId);

      const transferPayload = {
        roomId: stringRoomId,
        hostId: payload.hostId || null,
        fromUserId: requesterId,
        transferToUserId: controllerUserId,
        transferToUid: controllerUid,
        controller: roomControllers[stringRoomId] || controller || null,
        message: controllerUserId || controllerUid !== null
          ? 'Room is staying open. Control moved to another room user.'
          : 'Room is staying open while the host is away.',
      };

      io.to(stringRoomId).emit('host_left_room', transferPayload);
      io.to(stringRoomId).emit('room_control_transferred', transferPayload);
      io.to(stringRoomId).emit('room_controller_changed', transferPayload);

      if (isVideoRoom && (controllerUserId || controllerUid !== null)) {
        io.to(stringRoomId).emit('video_room_admin_assigned', {
          controller: transferPayload.controller,
          assignedMessage: 'You can manage this video room while the host is away.',
        });
      }

      await emitRoomStats(stringRoomId);
    } catch (error) {
      console.log('Keep room open event error:', error);
      socket.emit('error_notice', { message: 'Unable to keep this room open.' });
    }
  };

  socket.on('host_leave_keep_room_open', handleKeepRoomOpen);
  socket.on('controller_leave_keep_room_open', handleKeepRoomOpen);
  socket.on('room_control_transfer', handleKeepRoomOpen);

  const isRequesterRoomHost = async (roomId, requesterId) => {
    const stringRoomId = roomId ? roomId.toString() : '';
    const actorId = requesterId || socket.userId;
    if (!stringRoomId || !actorId) return { allowed: false, stringRoomId, isVideoRoom: false, room: null };

    const isVideoRoom = stringRoomId.startsWith('glix_');
    const room = isVideoRoom
      ? await Room.findOne({ channelName: stringRoomId })
      : mongoose.Types.ObjectId.isValid(stringRoomId)
        ? await AudioRoom.findById(stringRoomId)
        : null;

    const controller = roomControllers[stringRoomId] || null;
    const actorIsHost = !!room && String(room.hostId || '') === String(actorId || '');
    const actorIsController = !!controller && (
      (controller.userId && String(controller.userId) === String(actorId || '')) ||
      (controller.uid !== null && controller.uid !== undefined && String(controller.uid) === String(socket.numericUid || ''))
    );
    console.log('[RoomAdmin][Backend][permission-check]', {
      roomId: stringRoomId,
      requesterId,
      socketUserId: socket.userId || null,
      actorId,
      isVideoRoom,
      roomFound: !!room,
      roomHostId: room?.hostId?.toString?.() || room?.hostId || null,
      controller,
      actorIsHost,
      actorIsController,
      allowed: !!room && (actorIsHost || actorIsController),
    });

    return {
      allowed: !!room && (actorIsHost || actorIsController),
      isHost: actorIsHost,
      isController: actorIsController,
      stringRoomId,
      isVideoRoom,
      room
    };
  };

  const handleAssignRoomAdmin = async (payload = {}, mode = 'audio') => {
    try {
      console.log('[RoomAdmin][Backend][assign-received]', { mode, payload });
      const { allowed, stringRoomId, room } = await isRequesterRoomHost(payload.roomId, payload.requesterId);
      if (!allowed) {
        console.log('[RoomAdmin][Backend][assign-rejected]', {
          reason: 'permission_denied',
          mode,
          roomId: payload.roomId,
          requesterId: payload.requesterId,
        });
        socket.emit('error_notice', { message: 'Only the host or room admin can make a room admin.' });
        return;
      }

      const targetSlotIndex = Number(payload.targetSlotIndex);
      const targetUid = payload.targetUid ?? payload.uid ?? null;
      let targetUserId = payload.targetUserId || null;
      if (!targetUserId && Number.isInteger(targetSlotIndex)) {
        if (stringRoomId.startsWith('glix_')) {
          const slot = Array.isArray(room.slots)
            ? room.slots.find(item => Number(item?.id) === targetSlotIndex + 1)
            : null;
          targetUserId = slot?.userId || null;
        } else {
          const speaker = Array.isArray(room.speakers)
            ? room.speakers.find(item => (
              Number(item?.slotIndex) === targetSlotIndex ||
              (targetUid !== null && targetUid !== undefined && String(item?.numericUid || '') === String(targetUid))
            ))
            : null;
          targetUserId = speaker?.userId || null;
        }
      }
      targetUserId = targetUserId?.toString?.() || targetUserId;
      console.log('[RoomAdmin][Backend][assign-resolved]', {
        mode,
        roomId: stringRoomId,
        targetSlotIndex,
        targetUid,
        targetUserId,
        roomSpeakers: Array.isArray(room?.speakers) ? room.speakers.map(item => ({
          userId: item?.userId?.toString?.() || item?.userId || null,
          slotIndex: item?.slotIndex,
          numericUid: item?.numericUid,
        })) : undefined,
        roomSlots: Array.isArray(room?.slots) ? room.slots.map(item => ({
          id: item?.id,
          userId: item?.userId?.toString?.() || item?.userId || null,
          uid: item?.uid,
          username: item?.username,
        })) : undefined,
      });
      if (!targetUserId || !Number.isInteger(targetSlotIndex) || targetUid === null || targetUid === undefined) {
        console.log('[RoomAdmin][Backend][assign-rejected]', {
          reason: 'missing_target',
          mode,
          roomId: stringRoomId,
          targetSlotIndex,
          targetUid,
          targetUserId,
        });
        socket.emit('error_notice', { message: 'Selected user is not available on this slot.' });
        return;
      }

      const controller = {
        userId: targetUserId.toString(),
        uid: targetUid,
        targetSlotIndex,
      };
      roomControllers[stringRoomId] = controller;
      console.log('[RoomAdmin][Backend][assign-broadcast]', {
        mode,
        roomId: stringRoomId,
        controller,
        event: mode === 'video' ? 'video_room_admin_assigned' : 'audio_room_host_assigned',
      });

      io.to(stringRoomId).emit(mode === 'video' ? 'video_room_admin_assigned' : 'audio_room_host_assigned', {
        controller,
        roomId: stringRoomId,
        hostId: room.hostId,
        message: 'Room admin assigned.'
      });
    } catch (error) {
      console.log('Assign room admin error:', error);
      socket.emit('error_notice', { message: 'Unable to assign room admin.' });
    }
  };

  const handleRemoveSlotUser = async (payload = {}, mode = 'audio') => {
    try {
      console.log('[RoomAdmin][Backend][remove-received]', { mode, payload });
      const { allowed, stringRoomId, isVideoRoom, room } = await isRequesterRoomHost(payload.roomId, payload.requesterId);
      if (!allowed) {
        console.log('[RoomAdmin][Backend][remove-rejected]', {
          reason: 'permission_denied',
          mode,
          roomId: payload.roomId,
          requesterId: payload.requesterId,
        });
        socket.emit('error_notice', { message: 'Only the host or room admin can remove a slot user.' });
        return;
      }

      const targetSlotIndex = Number(payload.targetSlotIndex);
      const targetUid = payload.targetUid ?? payload.uid ?? null;
      let targetUserId = payload.targetUserId || null;
      if (!targetUserId && Number.isInteger(targetSlotIndex)) {
        if (isVideoRoom) {
          const slot = Array.isArray(room.slots)
            ? room.slots.find(item => Number(item?.id) === targetSlotIndex + 1)
            : null;
          targetUserId = slot?.userId || null;
        } else {
          const speaker = Array.isArray(room.speakers)
            ? room.speakers.find(item => (
              Number(item?.slotIndex) === targetSlotIndex ||
              (targetUid !== null && targetUid !== undefined && String(item?.numericUid || '') === String(targetUid))
            ))
            : null;
          targetUserId = speaker?.userId || null;
        }
      }
      targetUserId = targetUserId?.toString?.() || targetUserId;
      console.log('[RoomAdmin][Backend][remove-resolved]', {
        mode,
        roomId: stringRoomId,
        isVideoRoom,
        targetSlotIndex,
        targetUid,
        targetUserId,
        roomHostId: room?.hostId?.toString?.() || room?.hostId || null,
        roomSpeakers: Array.isArray(room?.speakers) ? room.speakers.map(item => ({
          userId: item?.userId?.toString?.() || item?.userId || null,
          slotIndex: item?.slotIndex,
          numericUid: item?.numericUid,
        })) : undefined,
        roomSlots: Array.isArray(room?.slots) ? room.slots.map(item => ({
          id: item?.id,
          userId: item?.userId?.toString?.() || item?.userId || null,
          uid: item?.uid,
          username: item?.username,
        })) : undefined,
      });
      if (!Number.isInteger(targetSlotIndex) || targetSlotIndex < 0) {
        console.log('[RoomAdmin][Backend][remove-rejected]', {
          reason: 'invalid_slot',
          mode,
          roomId: stringRoomId,
          targetSlotIndex,
        });
        socket.emit('error_notice', { message: 'Invalid slot selected.' });
        return;
      }

      if (String(targetUserId || '') === String(room.hostId || '')) {
        console.log('[RoomAdmin][Backend][remove-rejected]', {
          reason: 'target_is_host',
          mode,
          roomId: stringRoomId,
          targetUserId,
          hostId: room.hostId?.toString?.() || room.hostId,
        });
        socket.emit('error_notice', { message: 'The main host cannot be removed from here.' });
        return;
      }

      if (isVideoRoom) {
        if (targetSlotIndex <= 0 || targetSlotIndex > 2) {
          console.log('[RoomAdmin][Backend][remove-rejected]', {
            reason: 'invalid_video_slot',
            mode,
            roomId: stringRoomId,
            targetSlotIndex,
          });
          socket.emit('error_notice', { message: 'Only co-host slots can be removed.' });
          return;
        }

        await Room.findOneAndUpdate(
          { channelName: stringRoomId, 'slots.id': targetSlotIndex + 1 },
          {
            $set: {
              'slots.$.userId': null,
              'slots.$.uid': null,
              'slots.$.username': `Co-Host ${targetSlotIndex + 1}`,
              'slots.$.avatar': null,
              'slots.$.frameUrl': null,
              'slots.$.isMuted': false,
              'slots.$.cameraOn': false
            }
          }
        );
      } else {
        await AudioRoom.findByIdAndUpdate(stringRoomId, {
          $pull: { speakers: { slotIndex: targetSlotIndex } },
          $set: { lastHeartbeatAt: new Date() }
        });
      }

      io.to(stringRoomId).emit('slot_state_changed', {
        slotIndex: targetSlotIndex,
        user: {
          uid: null,
          userId: null,
          username: isVideoRoom ? `Co-Host ${targetSlotIndex + 1}` : `${targetSlotIndex + 1}`,
          avatar: null,
          frameUrl: null,
          isMuted: false,
          cameraOn: false
        }
      });
      await emitRoomSlotsSnapshot(stringRoomId);

      const removalPayload = {
        roomId: stringRoomId,
        targetUserId,
        targetUid,
        targetSlotIndex,
        kickFromRoom: true,
        message: 'The host removed you from the room.'
      };
      console.log('[RoomAdmin][Backend][remove-broadcast]', {
        mode,
        roomId: stringRoomId,
        event: isVideoRoom || mode === 'video' ? 'video_mic_user_removed' : 'audio_mic_user_removed',
        removalPayload,
      });

      const currentController = roomControllers[stringRoomId];
      if (currentController && (
        (targetUserId && String(currentController.userId || '') === String(targetUserId || '')) ||
        (targetUid !== null && targetUid !== undefined && String(currentController.uid || '') === String(targetUid))
      )) {
        delete roomControllers[stringRoomId];
      }

      io.to(stringRoomId).emit(isVideoRoom || mode === 'video' ? 'video_mic_user_removed' : 'audio_mic_user_removed', removalPayload);
      io.to(stringRoomId).emit('mic_user_removed', removalPayload);
      console.log(removalPayload);
    } catch (error) {
      console.log('Remove slot user error:', error);
      socket.emit('error_notice', { message: 'Unable to remove this slot user.' });
    }
  };

  socket.on('assign_audio_room_host', payload => handleAssignRoomAdmin(payload, 'audio'));
  socket.on('assign_video_room_admin', payload => handleAssignRoomAdmin(payload, 'video'));
  socket.on('remove_audio_mic_user', payload => handleRemoveSlotUser(payload, 'audio'));
  socket.on('remove_video_mic_user', payload => handleRemoveSlotUser(payload, 'video'));

  socket.on('update_audio_room_layout', async ({ roomId, requesterId, micSeatCount, micLayoutType, backgroundThemeId, backgroundThemeUrl }) => {
    try {
      const stringRoomId = roomId ? roomId.toString() : '';
      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return;

      const nextSeatCount = [5, 10, 15, 24].includes(Number(micSeatCount)) ? Number(micSeatCount) : 15;
      const nextLayoutType = ['chatroom', 'dating', 'party', 'birthday'].includes(micLayoutType) ? micLayoutType : 'chatroom';
      const nextBackgroundThemeId = backgroundThemeId ? String(backgroundThemeId) : null;
      let nextBackgroundThemeUrl = backgroundThemeUrl ? String(backgroundThemeUrl) : null;

      const audioRoom = await AudioRoom.findById(stringRoomId).populate('speakers.userId', 'name profilePic frameUrl');
      if (!audioRoom) {
        socket.emit('error_notice', { message: 'Audio room not found.' });
        return;
      }

      const canUpdateLayout = String(audioRoom.hostId || '') === String(requesterId || '') || String(audioRoom.hostId || '') === String(socket.userId || '');
      if (!canUpdateLayout) {
        socket.emit('error_notice', { message: 'Only the host can change the mic arrangement.' });
        return;
      }

      const hasOccupiedOutsideLayout = (audioRoom.speakers || []).some(speaker => Number(speaker.slotIndex) >= nextSeatCount);
      if (hasOccupiedOutsideLayout) {
        socket.emit('error_notice', { message: 'Please clear higher mic slots before reducing seats.' });
        return;
      }

      if (nextBackgroundThemeId?.startsWith('custom-theme-')) {
        const customThemeId = nextBackgroundThemeId.replace(/^custom-theme-/, '');
        if (!mongoose.Types.ObjectId.isValid(customThemeId)) {
          socket.emit('error_notice', { message: 'Invalid custom room theme.' });
          return;
        }

        const customTheme = await CustomRoomTheme.findOne({
          _id: customThemeId,
          userId: requesterId,
          status: 'approved',
          expiresAt: { $gt: new Date() },
        }).lean();

        if (!customTheme) {
          socket.emit('error_notice', { message: 'This custom room theme is not approved or has expired.' });
          return;
        }
        nextBackgroundThemeUrl = customTheme.imageUrl;
      }

      audioRoom.micSeatCount = nextSeatCount;
      audioRoom.micLayoutType = nextLayoutType;
      audioRoom.backgroundThemeId = nextBackgroundThemeId;
      audioRoom.backgroundThemeUrl = nextBackgroundThemeUrl;
      audioRoom.lastHeartbeatAt = new Date();
      await audioRoom.save();

      const completeLayoutMatrix = createCleanSlotsBlueprint();
      (audioRoom.speakers || []).filter(speaker => speaker && speaker.userId).forEach(speaker => {
        const index = Number(speaker.slotIndex);
        if (index >= 0 && index < 25) {
          completeLayoutMatrix[index] = {
            ...completeLayoutMatrix[index],
            uid: speaker.numericUid || null,
            userId: speaker.userId?._id?.toString?.() || speaker.userId?.toString?.() || null,
            username: speaker.userId?.name || 'Broadcaster',
            avatar: speaker.userId?.profilePic || null,
            frameUrl: speaker.frameUrl || speaker.userId?.frameUrl || null,
            isMuted: speaker.isMuted || false,
          };
        }
      });

      const lockedSlots = new Set((audioRoom.lockedSlots || []).map(Number));
      io.to(stringRoomId).emit('room_layout_changed', {
        slots: completeLayoutMatrix.map((slot, index) => ({ ...slot, locked: lockedSlots.has(index) })),
        micSeatCount: audioRoom.micSeatCount,
        micLayoutType: audioRoom.micLayoutType,
        backgroundThemeId: audioRoom.backgroundThemeId || null,
        backgroundThemeUrl: audioRoom.backgroundThemeUrl || null,
      });
    } catch (error) {
      console.log('Update audio room layout error:', error);
      socket.emit('error_notice', { message: 'Failed to update room layout.' });
    }
  });

  // 3. EVENT: Chat Messages
  socket.on('send_message', async ({ roomId, senderName, text, userId, mentions = [] }) => {
    const stringRoomId = roomId ? roomId.toString() : '';
    const normalizedMentions = [...new Set(
      (Array.isArray(mentions) ? mentions : [])
        .map(id => id?.toString?.() || String(id || ''))
        .filter(Boolean)
    )];
    const stringUserId = userId ? userId.toString() : '';
    let senderLevel = 1;

    try {
      if (mongoose.Types.ObjectId.isValid(stringUserId)) {
        const sender = await User.findById(stringUserId).select('sentGiftCoins').lean();
        senderLevel = calculateUserLevelValue(sender?.sentGiftCoins || 0);
      }
    } catch (error) {
      console.log('Unable to calculate chat sender level:', error.message);
    }

    io.to(stringRoomId).emit('receive_message', {
      id: Date.now().toString() + Math.random().toString(),
      type: 'user',
      sender: senderName,
      text: text,
      userId: stringUserId || userId,
      mentions: normalizedMentions,
      level: senderLevel
    });
  });

  socket.on('clear_room_chat', async ({ roomId, requesterId, roomMode }) => {
    try {
      const stringRoomId = roomId ? roomId.toString() : '';
      const stringRequesterId = requesterId ? requesterId.toString() : '';
      if (!stringRoomId || !stringRequesterId) {
        socket.emit('error_notice', { message: 'Unable to clean chat right now.' });
        return;
      }

      let hostId = '';
      if (roomMode === 'audio' && mongoose.Types.ObjectId.isValid(stringRoomId)) {
        const audioRoom = await AudioRoom.findById(stringRoomId).select('hostId').lean();
        hostId = audioRoom?.hostId?.toString?.() || '';
      } else {
        const videoQuery = mongoose.Types.ObjectId.isValid(stringRoomId)
          ? { $or: [{ _id: stringRoomId }, { channelName: stringRoomId }] }
          : { channelName: stringRoomId };
        const videoRoom = await Room.findOne(videoQuery).select('hostId channelName').lean();
        hostId = videoRoom?.hostId?.toString?.() || '';
      }

      if (!hostId || String(hostId) !== String(stringRequesterId)) {
        socket.emit('error_notice', { message: 'Only the host can clean room chat.' });
        return;
      }

      io.to(stringRoomId).emit('room_chat_cleared', {
        roomId: stringRoomId,
        clearedBy: stringRequesterId,
        roomMode: roomMode || 'room',
        clearedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.log('Clear room chat error:', error);
      socket.emit('error_notice', { message: 'Failed to clean room chat.' });
    }
  });

  socket.on('send_expressive_emoji', (payload = {}) => {
    const stringRoomId = payload.roomId ? payload.roomId.toString() : '';
    const emoji = String(payload.emoji || payload.text || '').trim();
    if (!stringRoomId || !emoji) return;

    const incomingSlotIndex = payload.targetSlotIndex ?? payload.slotIndex ?? null;
    const targetSlotIndex = Number.isInteger(incomingSlotIndex)
      ? incomingSlotIndex
      : Number.isFinite(Number(incomingSlotIndex))
        ? Number(incomingSlotIndex)
        : null;

    io.to(stringRoomId).emit('receive_expressive_emoji', {
      ...payload,
      id: payload.id || `expressive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: 'expressive_emoji',
      roomId: stringRoomId,
      emoji,
      text: emoji,
      targetSlotIndex,
      numericUid: payload.numericUid ?? payload.uid ?? null,
      userId: payload.userId || null,
      senderName: payload.senderName || payload.sender || 'User'
    });
  });

  socket.on('send_gift', async ({ roomId, senderName, hostId, giftId, gift, giftAnimationUrl, giftThumbnail, giftMediaType, giftName, avatar, userId, quantity, coins, receiverIds = [], isLuckyGift: clientIsLuckyGift = false }) => {

    console.log('gift data:', userId, roomId, hostId, coins, receiverIds);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      socket.emit('gift_error', { message: 'Invalid gift sender received.' });
      return;
    }

    const stringRoomId = roomId ? roomId.toString() : '';
    const roomMode = stringRoomId.startsWith('glix_') ? 'video' : mongoose.Types.ObjectId.isValid(stringRoomId) ? 'audio' : 'unknown';
    const resolvedRoomHostId = await resolveGiftRoomHostId(stringRoomId);
    const finalRoomHostId = resolvedRoomHostId || (mongoose.Types.ObjectId.isValid(hostId) ? hostId.toString() : '');

    if (!mongoose.Types.ObjectId.isValid(finalRoomHostId)) {
      socket.emit('gift_error', { message: 'Unable to identify this room host.' });
      return;
    }

    if (hostId && resolvedRoomHostId && String(hostId) !== String(resolvedRoomHostId)) {
      console.log('Gift hostId mismatch corrected from room record:', {
        roomId: stringRoomId,
        clientHostId: hostId,
        resolvedRoomHostId
      });
    }

    const fallbackReceiverId = finalRoomHostId;
    const normalizedReceiverIds = [...new Set(
      (Array.isArray(receiverIds) && receiverIds.length ? receiverIds : [fallbackReceiverId])
        .map(id => id?.toString?.() || String(id || ''))
        .filter(id => mongoose.Types.ObjectId.isValid(id))
    )];

    if (!normalizedReceiverIds.length) {
      console.error('Backend Error: Received no valid gift receiver IDs.');
      socket.emit('gift_error', { message: 'Invalid gift receiver received.' });
      return;
    }

    let catalogGift = null;
    if (mongoose.Types.ObjectId.isValid(giftId)) {
      catalogGift = await GiftCatalog.findOne({ _id: giftId, isActive: true }).lean();
      if (!catalogGift) {
        socket.emit('gift_error', { message: 'Gift is not available.' });
        return;
      }
    }

    const resolvedGiftName = catalogGift?.name || giftName;
    const resolvedGiftAnimation = catalogGift?.animationUrl || giftAnimationUrl || gift;
    const resolvedGiftThumbnail = catalogGift?.thumbnailUrl || giftThumbnail || '';
    const resolvedGiftMediaType = catalogGift?.mediaType || giftMediaType || detectGiftMediaType(resolvedGiftAnimation);
    const coinPrice = Number(catalogGift?.price ?? coins);
    let giftQuantity = Math.floor(Number(quantity));

    if (!Number.isFinite(coinPrice) || coinPrice <= 0) {
      socket.emit('gift_error', { message: 'Invalid gift price received.' });
      return;
    }

    if (!Number.isFinite(giftQuantity) || giftQuantity <= 0) {
      socket.emit('gift_error', { message: 'Invalid gift quantity received.' });
      return;
    }

    if (!GIFT_QUANTITY_OPTIONS.includes(giftQuantity)) {
      console.warn('Unsupported gift quantity received. Falling back to 1.', {
        roomId: stringRoomId,
        userId,
        quantity,
        giftQuantity,
      });
      giftQuantity = 1;
    }
    const perReceiverCost = coinPrice * giftQuantity;
    const totalCost = perReceiverCost * normalizedReceiverIds.length;
    const normalizedGiftName = String(resolvedGiftName || '').trim().toLowerCase();
    const isLuckyGiftEligible = catalogGift ? !!catalogGift.isLuckyGift : LUCKY_GIFT_NAMES.has(normalizedGiftName);
    const luckyChancePercent = isLuckyGiftEligible
      ? Number(catalogGift?.luckyReturnChance || LUCKY_GIFT_RETURN_CHANCE_PERCENT)
      : 0;
    const luckyGiftWon = isLuckyGiftEligible && luckyChancePercent > 0 && Math.random() * 100 < luckyChancePercent;
    const luckyRewardDiamonds = luckyGiftWon ? Math.floor(totalCost * LUCKY_GIFT_REWARD_MULTIPLIER) : 0;
    const luckyGiftResult = {
      eligible: isLuckyGiftEligible,
      won: luckyGiftWon,
      chancePercent: luckyChancePercent,
      rewardMultiplier: LUCKY_GIFT_REWARD_MULTIPLIER,
      rewardDiamonds: luckyRewardDiamonds
    };

    if (clientIsLuckyGift && !isLuckyGiftEligible) {
      console.warn('Client marked a non-lucky gift as lucky. Ignoring client flag.', {
        roomId: stringRoomId,
        userId,
        giftName: resolvedGiftName,
      });
    }

    let hostShareByReceiverId = {};
    let commissionRealtimeEvents = [];
    let giftCommitted = false;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const sender = await User.findOneAndUpdate(
        { _id: userId, chang: { $gte: totalCost } },
        { $inc: { chang: -totalCost, sentGiftCoins: totalCost } },
        { new: true, session }
      );

      if (!sender) throw new Error('Insufficient coins');

      const receiverObjectIds = normalizedReceiverIds.map(id => new mongoose.Types.ObjectId(id));
      const receiverDocs = await User.find({ _id: { $in: receiverObjectIds } })
        .select('name profilePic glixId daimon')
        .session(session)
        .lean();

      if (receiverDocs.length !== normalizedReceiverIds.length) {
        throw new Error('One or more gift receivers were not found.');
      }

      const receiverById = receiverDocs.reduce((map, receiver) => {
        map[receiver._id.toString()] = receiver;
        return map;
      }, {});

      let luckySenderDaimonAfter = 0;
      if (luckyRewardDiamonds > 0) {
        const luckySender = await User.findByIdAndUpdate(
          userId,
          { $inc: { daimon: luckyRewardDiamonds } },
          { new: true, session }
        ).select('daimon');
        luckySenderDaimonAfter = luckySender?.daimon || 0;
      }

      const commissionByReceiverId = {};
      await Promise.all(
        normalizedReceiverIds.map(async (receiverId) => {
          commissionByReceiverId[receiverId] = await recordGiftHierarchyCommission({
            receiverId,
            sourceCoins: perReceiverCost,
            session,
          });
        })
      );
      hostShareByReceiverId = normalizedReceiverIds.reduce((map, receiverId) => {
        const commission = commissionByReceiverId[receiverId] || {};
        const hostShare = Number.isFinite(Number(commission.hostShare))
          ? Number(commission.hostShare)
          : getCommissionAmount(perReceiverCost, HOST_GIFT_SHARE_PERCENT);
        map[receiverId] = Math.max(0, Math.floor(hostShare));
        return map;
      }, {});
      commissionRealtimeEvents = Object.values(commissionByReceiverId)
        .filter(Boolean)
        .flatMap(commission => ([
          commission.agencyId && {
            beneficiaryId: commission.agencyId,
            beneficiaryRole: 'agency',
            hostId: commission.hostId,
            sourceCoins: perReceiverCost,
            commissionAmount: commission.agencyCommission,
            ratePercent: commission.agencyRatePercent,
            month: commission.commissionMonth,
            day: commission.commissionDay,
          },
          commission.adminId && {
            beneficiaryId: commission.adminId,
            beneficiaryRole: 'admin',
            hostId: commission.hostId,
            sourceCoins: perReceiverCost,
            commissionAmount: commission.adminCommission,
            ratePercent: commission.adminRatePercent,
            month: commission.commissionMonth,
            day: commission.commissionDay,
          },
          commission.managerId && {
            beneficiaryId: commission.managerId,
            beneficiaryRole: 'manager',
            hostId: commission.hostId,
            sourceCoins: perReceiverCost,
            commissionAmount: commission.managerCommission,
            ratePercent: commission.managerRatePercent,
            month: commission.commissionMonth,
            day: commission.commissionDay,
          },
        ]))
        .filter(event => event && event.commissionAmount > 0);

      const receiverWalletUpdates = normalizedReceiverIds.map(receiverId => {
        return {
          updateOne: {
            filter: { _id: new mongoose.Types.ObjectId(receiverId) },
            update: { $inc: { daimon: hostShareByReceiverId[receiverId] || 0 } },
          },
        };
      });

      const receiverUpdate = await User.bulkWrite(receiverWalletUpdates, { session });
      if ((receiverUpdate.matchedCount ?? 0) !== normalizedReceiverIds.length) {
        throw new Error('One or more gift receivers were not found.');
      }

      await GiftTransaction.create(
        normalizedReceiverIds.map(receiverId => {
          const commission = commissionByReceiverId[receiverId] || {};
          const creditedHostShare = hostShareByReceiverId[receiverId] ?? perReceiverCost;
          return {
            roomId: stringRoomId,
            roomMode,
            senderId: userId,
            senderName: sender.name || senderName || 'User',
            senderAvatar: sender.profilePic || avatar || '',
            senderGlixId: sender.glixId || '',
            receiverId,
            receiverName: receiverById[receiverId]?.name || 'User',
            receiverAvatar: receiverById[receiverId]?.profilePic || '',
            receiverGlixId: receiverById[receiverId]?.glixId || '',
            receiverIds: receiverObjectIds,
            receiverCount: normalizedReceiverIds.length,
            giftName: resolvedGiftName,
            giftCatalogId: catalogGift?._id || null,
            giftImage: resolvedGiftAnimation,
            giftThumbnail: resolvedGiftThumbnail || '',
            giftMediaType: resolvedGiftMediaType,
            coinPrice,
            quantity: giftQuantity,
            perReceiverCost,
            totalCost: perReceiverCost,
            batchTotalCost: totalCost,
            agencyId: commission.agencyId || null,
            adminId: commission.adminId || null,
            managerId: commission.managerId || null,
            hostShare: creditedHostShare,
            agencyCommission: commission.agencyCommission || 0,
            adminCommission: commission.adminCommission || 0,
            managerCommission: commission.managerCommission || 0,
            platformCommission: Number.isFinite(Number(commission.platformCommission))
              ? Math.max(0, Math.floor(Number(commission.platformCommission)))
              : Math.max(0, perReceiverCost - creditedHostShare),
            commissionMonth: commission.commissionMonth || getCommissionMonthKey(),
            commissionDay: commission.commissionDay || getCommissionDayKey(),
            luckyGift: luckyGiftResult,
            status: 'completed',
            audit: {
              senderBalanceAfter: sender.chang || 0,
              receiverBalanceAfter: Number(receiverById[receiverId]?.daimon || 0) + creditedHostShare,
              luckySenderDaimonAfter,
              clientSenderName: senderName || '',
              roomHostId: new mongoose.Types.ObjectId(finalRoomHostId)
            }
          };
        }),
        { session }
      );

      await session.commitTransaction();
      giftCommitted = true;

    } catch (error) {
      if (!giftCommitted) await session.abortTransaction();
      socket.emit('gift_error', { message: error.message });
      return;
    } finally {
      session.endSession();
    }

    recordRewardActivity(userId, 'send_gift', { roomId: stringRoomId, totalCost, receiverIds: normalizedReceiverIds }).catch(error => {
      console.warn('Unable to record send gift reward activity:', error.message);
    });
    Promise.all(
      commissionRealtimeEvents.map(event => emitCommissionUpdated(event.beneficiaryId, event))
    ).catch(error => {
      console.warn('Unable to emit real-time commission update:', error.message);
    });

    io.to(stringRoomId).emit('receive_gift', {
      id: Date.now().toString() + Math.random().toString(),
      type: 'gift',
      sender: senderName,
      giftId: catalogGift?._id?.toString?.() || giftId || null,
      gift: resolvedGiftAnimation,
      giftAnimationUrl: resolvedGiftAnimation,
      giftThumbnail: resolvedGiftThumbnail || '',
      giftMediaType: resolvedGiftMediaType,
      giftName: resolvedGiftName,
      avatar,
      quantity: giftQuantity,
      coins: coinPrice,
      totalCost,
      perReceiverCost,
      perReceiverHostShare: getCommissionAmount(perReceiverCost, HOST_GIFT_SHARE_PERCENT),
      hostShareByReceiverId,
      receiverIds: normalizedReceiverIds,
      roomHostId: finalRoomHostId,
      luckyGift: luckyGiftResult,
      userId
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
        await upsertRoomPresence({
          roomId: stringRoomId,
          userId: acceptedUserId,
          socketId: activeUsers[String(acceptedUserId)] || null,
          name: data.user.username || data.user.name,
          profilePic: data.user.avatar || data.user.profilePic,
          numericUid: data.user.uid ?? data.user.numericUid ?? null,
          role: isVideoRoom ? 'cohost' : 'speaker'
        });

        await Room.findOneAndUpdate(
          { channelName: stringRoomId, "slots.id": acceptedSlotIndex + 1 },
          {
            $set: {
              "slots.$.userId": acceptedUserId,
              "slots.$.uid": parseInt(data.user.uid ?? data.user.numericUid, 10),
              "slots.$.username": data.user.username || data.user.name || 'Co-Host',
              "slots.$.avatar": data.user.avatar || data.user.profilePic || '',
              "slots.$.frameUrl": data.user.frameUrl || null,
              "slots.$.isMuted": false,
              "slots.$.cameraOn": data.user.cameraOn !== false
            }
          }
        );

        io.to(stringRoomId).emit('slot_state_changed', {
          slotIndex: acceptedSlotIndex,
          user: {
            uid: data.user.uid ?? data.user.numericUid,
            userId: acceptedUserId,
            username: data.user.username || data.user.name || 'Co-Host',
            avatar: data.user.avatar || data.user.profilePic || '',
            frameUrl: data.user.frameUrl || null,
            isMuted: false,
            cameraOn: data.user.cameraOn !== false
          }
        });
        await emitRoomSlotsSnapshot(stringRoomId);
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

      await upsertRoomPresence({
          roomId: stringRoomId,
          userId: acceptedUserId,
          socketId: activeUsers[String(acceptedUserId)] || null,
          name: data.user.username || data.user.name,
          profilePic: data.user.avatar || data.user.profilePic,
          numericUid: data.user.uid ?? data.user.numericUid ?? null,
          role: isVideoRoom ? 'cohost' : 'speaker'
        });

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
      await emitRoomSlotsSnapshot(stringRoomId);

    } catch (err) {
      console.log("Host response error:", err);
    }
  });

  socket.on('register_user', (userId) => {
    if (joinUserSocketRoom(socket, userId)) {
      const cleanUserId = userId.toString();
      socket.join(cleanUserId);
      console.log(`SUCCESS: User ${cleanUserId} joined room: ${cleanUserId}`);
      // Send a confirmation back to the client to verify connection
      socket.emit('system_message', `Successfully joined room: ${cleanUserId}`);
    } else {
      console.log("ERROR: Attempted to join room with empty userId");
    }
  });

  socket.on('join_user_channel', async (payload = {}) => {
    try {
      const joined = await joinAuthenticatedUserSocketRoom(socket, payload);
      if (!joined) {
        socket.emit('wallet_channel_error', { message: 'Unable to join wallet channel.' });
      }
    } catch (error) {
      console.log('join_user_channel error:', error.message);
      socket.emit('wallet_channel_error', { message: 'Unable to join wallet channel.' });
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
      io.to(receiverId.toString()).emit('chat_unread_changed', {
        userId: receiverId,
        partnerId: senderId,
        reason: 'new_message',
      });
      io.to(senderId.toString()).emit('chat_unread_changed', {
        userId: senderId,
        partnerId: receiverId,
        reason: 'message_sent',
      });

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
      io.to(userId.toString()).emit('chat_unread_changed', {
        userId,
        partnerId,
        reason: 'messages_read',
      });
      io.to(partnerId.toString()).emit('chat_unread_changed', {
        userId: partnerId,
        partnerId: userId,
        reason: 'messages_read_receipt',
      });

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
    console.log("Server received request for chat list. UserID:", userId);
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

  socket.on('room_app_background', ({ roomId, userId, roomMode }) => {
    const stringRoomId = roomId ? roomId.toString() : '';
    if (!stringRoomId || !userId) return;

    socket.roomId = stringRoomId;
    socket.userId = userId;

    io.to(stringRoomId).emit('room_user_backgrounded', {
      userId,
      roomMode: roomMode || (stringRoomId.startsWith('glix_') ? 'video' : 'audio'),
    });
  });

  socket.on('room_app_foreground', ({ roomId, userId, roomMode }) => {
    const stringRoomId = roomId ? roomId.toString() : '';
    if (!stringRoomId || !userId) return;

    socket.roomId = stringRoomId;
    socket.userId = userId;

    clearRoomEmptyAudienceTimer(stringRoomId);

    if (clearRoomDisconnectTimer(stringRoomId, userId)) {
      io.to(stringRoomId).emit('host_reconnected', {
        userId,
        roomMode: roomMode || (stringRoomId.startsWith('glix_') ? 'video' : 'audio'),
        message: 'Host reconnected.'
      });
    }
  });

  // 7. EVENT: Safe Disconnect Handler
  socket.on('disconnect', async () => {
    try {
      if (socket.userId) {
        const activeUserKey = socket.userId.toString();
        if (activeUsers[activeUserKey] === socket.id) {
          delete activeUsers[activeUserKey];
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

      if (roomId.startsWith('glix_')) {
        const videoRoomDoc = await Room.findOne({ channelName: roomId });

      if (
        videoRoomDoc &&
        videoRoomDoc.hostId &&
        videoRoomDoc.hostId.toString() === currentUserId
      ) {
        if (roomKeepOpenRooms[roomId]) {
          removeRoomPresence({ roomId, userId: currentUserId, socketId: socket.id });
          await emitRoomStats(roomId);
          return;
        }

        io.to(roomId).emit('host_reconnecting', {
          userId: currentUserId,
          message: 'Host connection lost. Waiting for reconnect...'
          });

          const timerKey = getRoomDisconnectTimerKey(roomId, currentUserId);
          if (roomDisconnectTimers.has(timerKey)) clearTimeout(roomDisconnectTimers.get(timerKey));

          const timer = setTimeout(async () => {
            try {
              roomDisconnectTimers.delete(timerKey);
              removeRoomPresence({ roomId, userId: currentUserId, socketId: socket.id });

              const latestRoom = await Room.findOne({ channelName: roomId });
              if (!latestRoom || latestRoom.hostId?.toString() !== currentUserId) return;

              io.to(roomId).emit('room_closing', {
                message: 'Host disconnected. Room closed.'
              });

              await recordHostLiveSessionActivity({
                hostId: latestRoom.hostId,
                roomId,
                roomMode: 'video',
                startedAt: latestRoom.createdAt,
                endedAt: new Date()
              });
              await Room.deleteOne({ channelName: roomId });
              delete roomKeepOpenRooms[roomId];
              delete roomControllers[roomId];
              console.log(`Video room closed after reconnect grace expired: ${roomId}`);
            } catch (error) {
              console.log('Video room delayed disconnect cleanup error:', error);
            }
          }, ROOM_RECONNECT_GRACE_MS);

          roomDisconnectTimers.set(timerKey, timer);
          return;
        }

        removeRoomPresence({ roomId, userId: currentUserId, socketId: socket.id });
        await emitRoomStats(roomId);
        return;
      }

      const room = await AudioRoom.findById(roomId);

      if (
        room &&
        room.hostId &&
        room.hostId.toString() === currentUserId
      ) {
        if (roomKeepOpenRooms[roomId]) {
          removeRoomPresence({ roomId, userId: currentUserId, socketId: socket.id });
          scheduleKeptOpenAudioRoomEmptyCheck(roomId, 'host_left_no_audience');
          return;
        }

        io.to(roomId).emit('host_reconnecting', {
          userId: currentUserId,
          message: 'Host connection lost. Waiting for reconnect...'
        });

        const timerKey = getRoomDisconnectTimerKey(roomId, currentUserId);
        if (roomDisconnectTimers.has(timerKey)) clearTimeout(roomDisconnectTimers.get(timerKey));

        const timer = setTimeout(async () => {
          try {
            roomDisconnectTimers.delete(timerKey);
            removeRoomPresence({ roomId, userId: currentUserId, socketId: socket.id });

            const latestRoom = await AudioRoom.findById(roomId);
            if (!latestRoom || latestRoom.hostId?.toString() !== currentUserId) return;

            const remainingSpeakers = (Array.isArray(latestRoom.speakers) ? latestRoom.speakers : [])
              .filter(speaker => speaker?.userId && String(speaker.userId) !== currentUserId);

            if (remainingSpeakers.length > 0) {
              const transferSpeaker = remainingSpeakers[remainingSpeakers.length - 1];
              const controllerUserId = transferSpeaker.userId?.toString?.() || String(transferSpeaker.userId || '');
              const controllerUid = transferSpeaker.numericUid ?? transferSpeaker.uid ?? null;
              const controllerProfile = controllerUserId
                ? await User.findById(controllerUserId).select('name profilePic frameUrl').lean()
                : null;
              const controller = {
                userId: controllerUserId || null,
                uid: controllerUid,
                username: controllerProfile?.name || 'Mic user',
                name: controllerProfile?.name || 'Mic user',
                avatar: controllerProfile?.profilePic || null,
                profilePic: controllerProfile?.profilePic || null,
                frameUrl: controllerProfile?.frameUrl || transferSpeaker.frameUrl || null,
              };

              latestRoom.isLive = true;
              latestRoom.speakers = remainingSpeakers;
              latestRoom.lastHeartbeatAt = new Date();
              latestRoom.endedAt = null;
              await latestRoom.save();

              roomKeepOpenRooms[roomId] = {
                userId: currentUserId,
                controllerUserId,
                controllerUid,
                roomMode: 'audio',
                updatedAt: Date.now(),
              };
              roomControllers[roomId] = controller;

              const transferPayload = {
                roomId,
                hostId: latestRoom.hostId?.toString?.() || currentUserId,
                fromUserId: currentUserId,
                transferToUserId: controllerUserId,
                transferToUid: controllerUid,
                controller,
                message: 'Room is staying open. Control moved to another room user.',
              };

              io.to(roomId).emit('host_left_room', transferPayload);
              io.to(roomId).emit('room_control_transferred', transferPayload);
              io.to(roomId).emit('room_controller_changed', transferPayload);
              await emitRoomSlotsSnapshot(roomId);
              await emitRoomStats(roomId);
              scheduleKeptOpenAudioRoomEmptyCheck(roomId, 'host_disconnected_mic_users_remaining');
              console.log(`Audio room kept open after host disconnect because mic users remain: ${roomId}`);
              return;
            }

            latestRoom.isLive = false;
            latestRoom.speakers = [];
            latestRoom.audience = [];
            latestRoom.endedAt = new Date();

            await latestRoom.save();
            clearRoomEmptyAudienceTimer(roomId);
            delete roomKeepOpenRooms[roomId];
            delete roomControllers[roomId];

            io.to(roomId).emit('audio_room_ended', {
              message: 'Host disconnected. Room closed.'
            });

            console.log(`Audio room closed after reconnect grace expired: ${roomId}`);
          } catch (error) {
            console.log('Audio room delayed disconnect cleanup error:', error);
          }
        }, ROOM_RECONNECT_GRACE_MS);

        roomDisconnectTimers.set(timerKey, timer);
        return;
      }

      removeRoomPresence({ roomId, userId: currentUserId, socketId: socket.id });

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

      scheduleKeptOpenAudioRoomEmptyCheck(roomId, 'last_audience_left');

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
      roles: normalizeUserRoles(user),
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

    const roomObjectId = new mongoose.Types.ObjectId();
    const uniqueChannelName = `glix_${roomObjectId.toString()}`;

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
      _id: roomObjectId,
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
        channelName: uniqueChannelName,
        title: newRoom.title,
        settings: serializeRoomSettings(newRoom)
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

    const [roomSummary] = await GiftTransaction.aggregate([
      {
        $match: {
          roomId: { $in: roomMatchValues }
        }
      },
      {
        $group: {
          _id: '$roomId',
          totalCoins: { $sum: '$totalCost' },
          totalGifts: { $sum: '$quantity' },
          totalTransactions: { $sum: 1 }
        }
      }
    ]);

    const receiverRows = await GiftTransaction.aggregate([
      {
        $match: {
          roomId: { $in: roomMatchValues },
          receiverId: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: '$receiverId',
          totalCoins: { $sum: '$totalCost' }
        }
      }
    ]);

    const receiverTotals = receiverRows.reduce((acc, row) => {
      if (row?._id) acc[row._id.toString()] = row.totalCoins || 0;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: {
        totalCoins: roomSummary?.totalCoins || 0,
        totalGifts: roomSummary?.totalGifts || 0,
        totalTransactions: roomSummary?.totalTransactions || 0,
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
app.get('/gift-history/global', async (req, res) => {
  try {
    const period = req.query.period || 'all';
    const match = {};

    if (period === '24h') {
      match.createdAt = { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };
    }

    const [summary] = await GiftTransaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalCoins: { $sum: '$totalCost' },
          totalGifts: { $sum: '$quantity' },
          totalTransactions: { $sum: 1 }
        }
      }
    ]);

    return res.status(200).json({
      success: true,
      data: {
        period,
        totalCoins: summary?.totalCoins || 0,
        totalGifts: summary?.totalGifts || 0,
        totalTransactions: summary?.totalTransactions || 0,
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/coin-bags/drop', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.body?.userId?.toString?.() || String(req.body?.userId || '');
    const roomId = req.body?.roomId?.toString?.() || String(req.body?.roomId || '');
    const amount = Number(req.body?.amount);
    const claimLimit = Number(req.body?.claimLimit || 10);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid user id.' });
    }

    if (!COIN_BAG_ALLOWED_AMOUNTS.includes(amount)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid coin bag amount.' });
    }

    if (!COIN_BAG_ALLOWED_CLAIM_LIMITS.includes(claimLimit)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid coin bag claim limit.' });
    }

    const room = await resolveCoinBagRoom(roomId);
    if (!room) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Live room not found.' });
    }

    const creator = await User.findOneAndUpdate(
      { _id: userId, chang: { $gte: amount } },
      { $inc: { chang: -amount } },
      { new: true, session }
    ).select('name profilePic glixId chang');

    if (!creator) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Insufficient coins for this coin bag.' });
    }

    const platformFeeCoins = Math.floor(amount * COIN_BAG_PLATFORM_FEE_RATE);
    const claimableCoins = Math.max(0, amount - platformFeeCoins);
    const claimAmount = Math.floor(claimableCoins / claimLimit);
    const distributableCoins = claimAmount * claimLimit;
    const undistributedCoins = Math.max(0, claimableCoins - distributableCoins);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + COIN_BAG_ACTIVE_MS);

    const [coinBag] = await CoinBag.create([{
      creatorId: new mongoose.Types.ObjectId(userId),
      roomId: room.roomId,
      roomType: room.roomType,
      roomTitle: room.title,
      totalCoins: amount,
      platformFeeCoins,
      claimableCoins,
      claimLimit,
      claimAmount,
      remainingClaims: claimLimit,
      undistributedCoins,
      remainingCoins: distributableCoins,
      status: 'active',
      expiresAt,
      createdAt: now,
    }], { session });

    await session.commitTransaction();

    const payload = serializeCoinBag(coinBag, {
      creatorName: creator.name || 'User',
      creatorAvatar: creator.profilePic || '',
      creatorGlixId: creator.glixId || '',
      durationMs: COIN_BAG_ACTIVE_MS,
    });

    io.emit('coin_bag_global_notice', payload);
    io.to(room.roomId).emit('coin_bag_dropped', payload);

    return res.status(201).json({
      success: true,
      data: payload,
      wallet: {
        chang: creator.chang || 0,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
});

app.get('/coin-bags/active/:roomId', async (req, res) => {
  try {
    const roomId = req.params.roomId?.toString?.() || String(req.params.roomId || '');
    const now = new Date();

    await CoinBag.updateMany(
      { roomId, status: 'active', expiresAt: { $lte: now } },
      { $set: { status: 'expired' } }
    );

    const bags = await CoinBag.find({
      roomId,
      status: 'active',
      expiresAt: { $gt: now },
      remainingCoins: { $gt: 0 },
    }).sort({ createdAt: -1 }).limit(3).lean();

    return res.json({
      success: true,
      data: bags.map(bag => serializeCoinBag(bag)),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/coin-bags/:coinBagId/claim', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { coinBagId } = req.params;
    const userId = req.body?.userId?.toString?.() || String(req.body?.userId || '');

    if (!mongoose.Types.ObjectId.isValid(coinBagId) || !mongoose.Types.ObjectId.isValid(userId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid claim request.' });
    }

    const existingClaim = await CoinBagClaim.findOne({ coinBagId, userId }).session(session);
    if (existingClaim) {
      await session.abortTransaction();
      return res.status(409).json({ success: false, message: 'You already claimed this coin bag.' });
    }

    const now = new Date();
    const bag = await CoinBag.findOne({
      _id: coinBagId,
      status: 'active',
      expiresAt: { $gt: now },
      remainingCoins: { $gt: 0 },
      remainingClaims: { $gt: 0 },
    }).session(session);

    if (!bag) {
      await CoinBag.updateOne({ _id: coinBagId, status: 'active', expiresAt: { $lte: now } }, { $set: { status: 'expired' } });
      await session.abortTransaction();
      return res.status(410).json({ success: false, message: 'This coin bag has expired.' });
    }

    if (!roomPresence[bag.roomId]?.[userId]) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Join this room before claiming the coin bag.' });
    }

    const claimedCoins = Math.max(0, Number(bag.claimAmount || 0));
    if (claimedCoins <= 0) {
      await CoinBag.updateOne({ _id: coinBagId }, { $set: { status: 'empty', remainingCoins: 0 } }).session(session);
      await session.abortTransaction();
      return res.status(410).json({ success: false, message: 'This coin bag is empty.' });
    }

    const remainingAfterClaim = Math.max(0, Number(bag.remainingCoins || 0) - claimedCoins);
    const remainingClaimsAfterClaim = Math.max(0, Number(bag.remainingClaims || 0) - 1);
    const statusAfterClaim = remainingAfterClaim <= 0 || remainingClaimsAfterClaim <= 0 ? 'empty' : 'active';

    const updatedBag = await CoinBag.findOneAndUpdate(
      {
        _id: coinBagId,
        status: 'active',
        expiresAt: { $gt: now },
        remainingCoins: { $gte: claimedCoins },
        remainingClaims: { $gt: 0 },
      },
      {
        $inc: { remainingCoins: -claimedCoins, remainingClaims: -1 },
        $set: { status: statusAfterClaim },
      },
      { new: true, session }
    );

    if (!updatedBag) {
      await session.abortTransaction();
      return res.status(409).json({ success: false, message: 'Coin bag changed. Please try again.' });
    }

    await CoinBagClaim.create([{
      coinBagId: new mongoose.Types.ObjectId(coinBagId),
      userId: new mongoose.Types.ObjectId(userId),
      roomId: bag.roomId,
      claimedCoins,
      createdAt: now,
    }], { session });

    const user = await User.findByIdAndUpdate(
      userId,
      { $inc: { chang: claimedCoins } },
      { new: true, session }
    ).select('name profilePic glixId chang');

    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    await session.commitTransaction();

    const payload = {
      coinBagId,
      roomId: bag.roomId,
      claimedCoins,
      remainingCoins: updatedBag.remainingCoins || 0,
      remainingClaims: updatedBag.remainingClaims || 0,
      status: updatedBag.status,
      userId,
      name: user.name || 'User',
      profilePic: user.profilePic || '',
    };

    io.to(bag.roomId).emit('coin_bag_claimed', payload);
    if (updatedBag.status !== 'active') {
      io.to(bag.roomId).emit('coin_bag_ended', {
        coinBagId,
        roomId: bag.roomId,
        status: updatedBag.status,
      });
    }

    return res.json({
      success: true,
      data: payload,
      wallet: {
        chang: user.chang || 0,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'You already claimed this coin bag.' });
    }
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
});
app.get('/gift-history/host/:hostId', async (req, res) => {
  try {
    const { hostId } = req.params;
    const period = req.query.period || 'all';
    const scope = req.query.scope || 'received';

    if (!mongoose.Types.ObjectId.isValid(hostId)) {
      return res.status(400).json({ success: false, message: 'Invalid host id' });
    }

    const hostObjectId = new mongoose.Types.ObjectId(hostId);
    let match;

    if (scope === 'rooms') {
      const hostRoomIds = await getHostRoomIdMatchValues(hostObjectId);
      match = {
        status: 'completed',
        $or: [
          { 'audit.roomHostId': hostObjectId }
        ]
      };

      if (hostRoomIds.length) {
        match.$or.push({
          roomId: { $in: hostRoomIds },
          $or: [
            { 'audit.roomHostId': { $exists: false } },
            { 'audit.roomHostId': null }
          ]
        });
      }
    } else {
      match = {
        status: 'completed',
        receiverId: hostObjectId
      };
    }

    if (period === '24h') {
      match.createdAt = { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };
    }

    const result = await GiftTransaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalCoins: { $sum: "$totalCost" },
          totalGifts: { $sum: "$quantity" },
          totalTransactions: { $sum: 1 }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        period,
        scope,
        totalCoins: result[0]?.totalCoins || 0,
        totalGifts: result[0]?.totalGifts || 0,
        totalTransactions: result[0]?.totalTransactions || 0
      },
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/gift-history/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const direction = ['sent', 'received', 'all'].includes(req.query.direction) ? req.query.direction : 'all';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);
    const match = direction === 'sent'
      ? { senderId: userObjectId }
      : direction === 'received'
        ? { receiverId: userObjectId }
        : { $or: [{ senderId: userObjectId }, { receiverId: userObjectId }] };

    const transactions = await GiftTransaction.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const totals = transactions.reduce((acc, item) => {
      const sentByUser = item.senderId?.toString?.() === userId;
      const receivedByUser = item.receiverId?.toString?.() === userId;

      if (sentByUser) acc.sentCoins += Number(item.totalCost || 0);
      if (receivedByUser) acc.receivedCoins += Number(item.totalCost || 0);
      acc.quantity += Number(item.quantity || 0);
      acc.transactions += 1;
      return acc;
    }, { sentCoins: 0, receivedCoins: 0, quantity: 0, transactions: 0 });

    return res.status(200).json({
      success: true,
      direction,
      totals,
      transactions: transactions.map(item => ({
        id: item._id,
        roomId: item.roomId,
        roomMode: item.roomMode || 'unknown',
        sender: {
          id: item.senderId,
          name: item.senderName || '',
          avatar: item.senderAvatar || '',
          glixId: item.senderGlixId || '',
        },
        receiver: {
          id: item.receiverId,
          name: item.receiverName || '',
          avatar: item.receiverAvatar || '',
          glixId: item.receiverGlixId || '',
        },
        receiverIds: item.receiverIds || [],
        receiverCount: item.receiverCount || 1,
        giftName: item.giftName || '',
        giftImage: item.giftImage || '',
        giftThumbnail: item.giftThumbnail || '',
        coinPrice: item.coinPrice || 0,
        quantity: item.quantity || 0,
        perReceiverCost: item.perReceiverCost || item.totalCost || 0,
        totalCost: item.totalCost || 0,
        batchTotalCost: item.batchTotalCost || item.totalCost || 0,
        status: item.status || 'completed',
        createdAt: item.createdAt,
      }))
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/create', async (req, res) => {
  try {
    const { title, hostId, numericUid } = req.body;
    const sanitizedUid = parseInt(numericUid, 10) || 0;
    const hostUser = mongoose.Types.ObjectId.isValid(hostId)
      ? await User.findById(hostId).select('frameUrl').lean()
      : null;

    const newRoom = new AudioRoom({
      title: title || "Live Audio Room",
      hostId,
      isLive: true,
      speakers: [{ userId: hostId, isMuted: false, slotIndex: 0, numericUid: sanitizedUid, frameUrl: hostUser?.frameUrl || null }],
      audience: [],
      lockedSlots: [3, 12, 19]
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
    const { roomId, userId, numericUid, roomPassword } = req.body;
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
        if (String(roomObj.hostId) !== String(userId) && !roomPasswordMatches(roomObj, roomPassword)) {
          return res.status(403).json({ success: false, requiresPassword: true, message: 'Room password is required.' });
        }

        isVideoRoom = true;
        channelName = roomObj.channelName;
        if (String(roomObj.hostId) === String(userId)) {
          userRole = RtcRole.PUBLISHER;
        }
        await Room.findByIdAndUpdate(roomObj._id, {
          $set: { isLive: true, lastHeartbeatAt: new Date() }
        });
      }
    }

    if (!isVideoRoom) {
      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return res.status(400).json({ error: "Invalid Room ID format" });
      roomObj = await AudioRoom.findById(stringRoomId);
      if (!roomObj) return res.status(404).json({ error: "Audio room not found" });
      if (String(roomObj.hostId) !== String(userId) && !roomPasswordMatches(roomObj, roomPassword)) {
        return res.status(403).json({ success: false, requiresPassword: true, message: 'Room password is required.' });
      }
      if (!roomObj.isLive && !roomObj.isPermanent) return res.status(400).json({ error: "This room has already ended" });
      if (!roomObj.isLive && roomObj.isPermanent) {
        roomObj.isLive = true;
        roomObj.endedAt = null;
      }

      const currentSpeakers = Array.isArray(roomObj.speakers) ? roomObj.speakers : [];
      const currentAudience = Array.isArray(roomObj.audience) ? roomObj.audience : [];
      const validSpeakers = currentSpeakers.filter(s => s && s.userId);
      const validAudience = currentAudience.filter(Boolean);
      const isRoomOwner = String(roomObj.hostId) === String(userId);
      const joiningUser = await User.findById(userId).select('frameUrl').lean();
      const existingSpeakerIndex = validSpeakers.findIndex(s => String(s.userId) === String(userId));
      const isAlreadySpeaker = existingSpeakerIndex !== -1;
      roomObj.speakers = validSpeakers;
      roomObj.audience = validAudience.filter(id => String(id) !== String(userId));
      roomObj.lastHeartbeatAt = new Date();

      if (isRoomOwner) {
        const nonOwnerSpeakers = roomObj.speakers.filter(s => String(s.userId) !== String(userId));
        const micSeatCount = Number(roomObj.micSeatCount || 15);
        const occupiedSlots = new Set(
          nonOwnerSpeakers
            .map(s => Number(s?.slotIndex))
            .filter(index => Number.isInteger(index) && index >= 0 && index < micSeatCount)
        );
        const previousOwnerSlot = validSpeakers.find(s => String(s.userId) === String(userId));
        const previousOwnerSlotIndex = Number(previousOwnerSlot?.slotIndex);
        const previousOwnerSlotAvailable = (
          Number.isInteger(previousOwnerSlotIndex) &&
          previousOwnerSlotIndex >= 0 &&
          previousOwnerSlotIndex < micSeatCount &&
          !occupiedSlots.has(previousOwnerSlotIndex)
        );
        const slotOneAvailable = !occupiedSlots.has(0);
        const firstFreeSlotIndex = Array.from({ length: micSeatCount }, (_, index) => index)
          .find(index => !occupiedSlots.has(index));
        const ownerSlotIndex = previousOwnerSlotAvailable
          ? previousOwnerSlotIndex
          : slotOneAvailable
            ? 0
            : firstFreeSlotIndex;

        roomObj.speakers = Number.isInteger(ownerSlotIndex)
          ? [
            {
              userId,
              isMuted: false,
              slotIndex: ownerSlotIndex,
              numericUid: sanitizedUid,
              frameUrl: joiningUser?.frameUrl || previousOwnerSlot?.frameUrl || null
            },
            ...nonOwnerSpeakers
          ]
          : nonOwnerSpeakers;
        userRole = RtcRole.PUBLISHER;
      } else if (isAlreadySpeaker) {
        roomObj.speakers[existingSpeakerIndex].numericUid = sanitizedUid;
        roomObj.speakers[existingSpeakerIndex].frameUrl = joiningUser?.frameUrl || roomObj.speakers[existingSpeakerIndex].frameUrl || null;
        userRole = RtcRole.PUBLISHER;
      } else {
        roomObj.audience.push(userId);
      }

      await roomObj.save();
    }

    if (!roomObj) return res.status(404).json({ error: "Room not found" });

    if (process.env.NODE_ENV !== 'production') {
      console.log('[RoomJoin]', {
        roomId: stringRoomId,
        channelName,
        userId,
        roomHostId: roomObj.hostId?.toString?.() || String(roomObj.hostId || ''),
        isVideoRoom,
        userRole: userRole === RtcRole.PUBLISHER ? 'speaker' : 'audience',
        numericUid: sanitizedUid,
      });
    }

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
        channelName,
        title: roomObj.title,
        micSeatCount: roomObj.micSeatCount,
        micLayoutType: roomObj.micLayoutType,
        backgroundThemeId: roomObj.backgroundThemeId,
        backgroundThemeUrl: roomObj.backgroundThemeUrl,
        settings: serializeRoomSettings(roomObj),
        isPermanent: !!roomObj.isPermanent,
        visibility: roomObj.visibility || 'public',
        isLive: !!roomObj.isLive
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

app.post('/audio-room/join-mic-slot', async (req, res) => {
  try {
    const { roomId, userId, numericUid, targetSlotIndex, isMuted } = req.body;
    const stringRoomId = roomId ? roomId.toString() : '';
    const slotIndex = Number(targetSlotIndex);
    const sanitizedUid = parseInt(numericUid, 10) || 0;

    if (!mongoose.Types.ObjectId.isValid(stringRoomId) || !mongoose.Types.ObjectId.isValid(userId) || !sanitizedUid) {
      return res.status(400).json({ success: false, message: 'Invalid mic slot request.' });
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0) {
      return res.status(400).json({ success: false, message: 'Invalid mic slot selected.' });
    }

    const user = await User.findById(userId).select('name profilePic frameUrl');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !appCertificate) {
      return res.status(500).json({ success: false, message: 'Agora credentials are not configured.' });
    }

    const reservation = await reserveAudioMicSlot({
      roomId: stringRoomId,
      userId,
      slotIndex,
      numericUid: sanitizedUid,
      isMuted: !!isMuted,
      frameUrl: user.frameUrl || null,
    });

    if (!reservation.ok) {
      return res.status(reservation.status || 409).json({
        success: false,
        message: reservation.message || 'Mic slot could not be reserved. Please try again.'
      });
    }

    const privilegeExpiredTs = Math.floor(Date.now() / 1000) + 3600;
    const agoraToken = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      stringRoomId,
      sanitizedUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    await upsertRoomPresence({
      roomId: stringRoomId,
      userId,
      socketId: activeUsers[userId.toString()] || null,
      name: user.name || 'User',
      profilePic: user.profilePic || '',
      numericUid: sanitizedUid,
      role: 'speaker'
    });

    io.to(stringRoomId).emit('slot_state_changed', {
      slotIndex,
      user: {
        uid: sanitizedUid,
        userId,
        username: user.name || 'User',
        avatar: user.profilePic || '',
        frameUrl: user.frameUrl || null,
        isMuted: !!isMuted,
      }
    });
    await emitRoomSlotsSnapshot(stringRoomId);

    return res.json({
      success: true,
      agoraToken,
      userRole: 'speaker',
      slotIndex,
      user: {
        uid: sanitizedUid,
        userId,
        username: user.name || 'User',
        avatar: user.profilePic || '',
        frameUrl: user.frameUrl || null,
        isMuted: !!isMuted,
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});
app.post('/regenerate-token', async (req, res) => {
  try {
    const { roomId, userId, numericUid, isBecomingSpeaker } = req.body;
    if (!roomId || !userId || !numericUid) return res.status(400).json({ error: "Missing required fields" });

    const sanitizedUid = parseInt(numericUid, 10) || 0;

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !appCertificate) {
      return res.status(500).json({ success: false, message: 'Agora credentials are not configured.' });
    }

    const resolvedRoom = await resolveAgoraRoomChannel(roomId);
    if (!resolvedRoom?.channelName) {
      return res.status(404).json({ success: false, message: 'Room not found for token regeneration.' });
    }

    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    // Determine role based on whether user is becoming a speaker
    const userRole = isBecomingSpeaker ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      resolvedRoom.channelName,
      sanitizedUid,
      userRole,
      privilegeExpiredTs
    );

    return res.status(200).json({
      success: true,
      agoraToken: token,
      channelName: resolvedRoom.channelName,
      roomMode: resolvedRoom.roomMode,
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
        await recordHostLiveSessionActivity({
          hostId: videoRoom.hostId,
          roomId: videoRoom.channelName,
          roomMode: 'video',
          startedAt: videoRoom.createdAt,
          endedAt: new Date()
        });
        await Room.deleteOne({ _id: videoRoom._id });
        clearRoomEmptyAudienceTimer(videoRoom.channelName);
        delete roomKeepOpenRooms[videoRoom.channelName];
        delete roomControllers[videoRoom.channelName];
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
    clearRoomEmptyAudienceTimer(stringRoomId);
    delete roomKeepOpenRooms[stringRoomId];
    delete roomControllers[stringRoomId];

    io.to(stringRoomId).emit('audio_room_ended', {
      message: "The live audio room has been closed by the host."
    });

    return res.status(200).json({ success: true, message: "Room closed cleanly." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const resolveRoomForDeepLink = async (roomId) => {
  const stringRoomId = String(roomId || '').trim();
  if (!stringRoomId) return null;

  const videoFilter = getVideoRoomFilter(stringRoomId);
  if (videoFilter) {
    const videoRoom = await Room.findOne(videoFilter).lean();
    if (videoRoom) {
      return {
        roomId: videoRoom.channelName,
        canonicalRoomId: videoRoom.channelName,
        dbRoomId: videoRoom._id?.toString?.() || String(videoRoom._id || ''),
        roomType: 'video',
        roomMode: 'video',
        routeName: 'VideoRoom',
        isLive: !!videoRoom.isLive,
        title: videoRoom.title || 'Glix Video Live',
        hostId: videoRoom.hostId?.toString?.() || String(videoRoom.hostId || ''),
        createdAt: videoRoom.createdAt,
        lastHeartbeatAt: videoRoom.lastHeartbeatAt
      };
    }
  }

  if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return null;

  const audioRoom = await AudioRoom.findById(stringRoomId).select('_id hostId title isLive createdAt lastHeartbeatAt').lean();
  if (!audioRoom) return null;

  return {
    roomId: audioRoom._id?.toString?.() || String(audioRoom._id),
    canonicalRoomId: audioRoom._id?.toString?.() || String(audioRoom._id),
    dbRoomId: audioRoom._id?.toString?.() || String(audioRoom._id),
    roomType: 'audio',
    roomMode: 'audio',
    routeName: 'VoiceRoom',
    isLive: !!audioRoom.isLive,
    title: audioRoom.title || 'Live Audio Room',
    hostId: audioRoom.hostId?.toString?.() || String(audioRoom.hostId || ''),
    createdAt: audioRoom.createdAt,
    lastHeartbeatAt: audioRoom.lastHeartbeatAt
  };
};

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

app.get('/rooms/resolve/:roomId', async (req, res) => {
  try {
    await closeStaleLiveRooms();
    const room = await resolveRoomForDeepLink(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
    return res.status(200).json({ success: true, ...room });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get(['/room/:roomId', '/r/:roomId'], async (req, res) => {
  try {
    await closeStaleLiveRooms();
    const room = await resolveRoomForDeepLink(req.params.roomId);
    const roomId = encodeURIComponent(req.params.roomId || '');
    const appLink = `glix://room/${roomId}`;
    const officialPortalUrl = process.env.OFFICIAL_PORTAL_URL || '';
    const officialRoomUrl = officialPortalUrl ? `${officialPortalUrl.replace(/\/$/, '')}/rooms/${roomId}` : '';
    const isLive = !!room?.isLive;
    const title = escapeHtml(room?.title || 'Glix Live Room');
    const roomLabel = room?.roomMode === 'video' ? 'Video room' : 'Voice room';
    const displayRoomId = escapeHtml(req.params.roomId || '');

    return res
      .status(room ? 200 : 404)
      .type('html')
      .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body{margin:0;font-family:Arial,sans-serif;background:#071012;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
    main{max-width:420px;width:100%;background:#101b1f;border:1px solid #203238;border-radius:18px;padding:24px;text-align:center}
    h1{font-size:24px;margin:0 0 8px}
    p{color:#b8c7cc;line-height:1.45}
    a{display:block;text-decoration:none;border-radius:14px;padding:13px 16px;margin-top:12px;font-weight:800}
    .primary{background:#0f766e;color:#fff}
    .secondary{background:#1f2937;color:#fff}
    .muted{font-size:12px;color:#7f9299;margin-top:16px}
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${room ? `${roomLabel} ${isLive ? 'is live now.' : 'has ended.'}` : 'This room link is no longer available.'}</p>
    ${isLive ? `<a class="primary" href="${appLink}">Open in Glix Live</a>` : ''}
    ${officialRoomUrl ? `<a class="secondary" href="${officialRoomUrl}">Open in Official Portal</a>` : ''}
    <p class="muted">Room ID: ${displayRoomId}</p>
  </main>
  ${isLive ? `<script>setTimeout(function(){ window.location.href = "${appLink}"; }, 350);</script>` : ''}
</body>
</html>`);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/rooms/:roomId/settings', async (req, res) => {
  try {
    const { room, roomMode } = await findRoomForSettings(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, message: 'Room not found' });

    return res.json({
      success: true,
      roomMode,
      settings: serializeRoomSettings(room),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/rooms/:roomId/settings', async (req, res) => {
  try {
    const requesterId = req.body?.requesterId?.toString?.() || String(req.body?.requesterId || '');
    const { room, roomMode, socketRoomId } = await findRoomForSettings(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, message: 'Room not found' });

    const hostId = room.hostId?.toString?.() || String(room.hostId || '');
    if (!requesterId || requesterId !== hostId) {
      return res.status(403).json({ success: false, message: 'Only the room host can update room settings.' });
    }

    const updates = buildRoomSettingsUpdate(req.body);
    if (req.body?.unlockRoom === true) {
      updates.roomPassword = '';
    }
    if (req.body?.coverData) {
      updates.coverUrl = await uploadRoomCoverAsset(req.body.coverData, socketRoomId || room._id?.toString?.() || 'room');
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'No room setting changes received.' });
    }

    Object.assign(room, updates);
    await room.save();

    const settings = serializeRoomSettings(room);
    io.to(socketRoomId).emit('room_settings_updated', {
      roomId: socketRoomId,
      roomMode,
      settings,
    });

    return res.json({ success: true, roomMode, settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/rooms/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(roomId)) return res.status(400).json({ error: "Malformed Object reference ID" });

    const room = await AudioRoom.findById(roomId)
      .populate('hostId', 'name profilePic username frameUrl')
      .populate('speakers.userId', 'name profilePic username frameUrl')
      .populate('audience', 'name profilePic username');

    if (!room) return res.status(404).json({ error: "Room not found" });
    return res.status(200).json({ success: true, room });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/permanent-rooms/mine/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    await closeStaleLiveRooms();
    await ensurePermanentAudioRoomForUser(userId);

    const followingRows = await Follow.find({ followerId: userId }).select('followingId').lean();
    const followingIds = followingRows
      .map(row => row.followingId?.toString?.() || String(row.followingId || ''))
      .filter(id => mongoose.Types.ObjectId.isValid(id));

    await Promise.all(followingIds.map(id => ensurePermanentAudioRoomForUser(id)));

    const [myRoom, followingRooms] = await Promise.all([
      AudioRoom.findOne({ hostId: userId, isPermanent: true })
        .populate('hostId', 'name profilePic username glixId')
        .sort({ createdAt: 1 })
        .lean(),
      followingIds.length
        ? AudioRoom.find({
          hostId: { $in: followingIds },
          isPermanent: true,
          visibility: 'followers'
        })
          .populate('hostId', 'name profilePic username glixId')
          .sort({ isLive: -1, lastHeartbeatAt: -1, createdAt: -1 })
          .lean()
        : Promise.resolve([])
    ]);

    return res.status(200).json({
      success: true,
      myRoom: myRoom ? serializePermanentAudioRoom(myRoom) : null,
      followingRooms: followingRooms.map(serializePermanentAudioRoom)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/live-rooms', async (req, res) => {
  try {
    await closeStaleLiveRooms();
    const freshCutoff = getLiveRoomFreshCutoff();

    const [audioRooms, videoRooms] = await Promise.all([
      AudioRoom.find({
        isLive: true,
        lastHeartbeatAt: { $gte: freshCutoff }
      }).populate('hostId', 'name profilePic username glixId').sort({ createdAt: -1 }).lean(),
      Room.find({
        isLive: true,
        lastHeartbeatAt: { $gte: freshCutoff }
      }).sort({ createdAt: -1 }).lean()
    ]);

    const videoHostIds = [...new Set(
      videoRooms
        .map(room => room.hostId?.toString?.() || String(room.hostId || ''))
        .filter(id => mongoose.Types.ObjectId.isValid(id))
    )];

    const videoHosts = videoHostIds.length
      ? await User.find({ _id: { $in: videoHostIds } }).select('name profilePic username glixId').lean()
      : [];
    const videoHostMap = new Map(videoHosts.map(user => [user._id.toString(), user]));

    const formattedAudioRooms = audioRooms.map(room => ({
      id: room._id?.toString?.() || String(room._id),
      _id: room._id?.toString?.() || String(room._id),
      roomId: room._id?.toString?.() || String(room._id),
      roomMode: 'audio',
      title: room.title || 'Live Audio Room',
      hasPassword: !!room.roomPassword,
      coverUrl: room.coverUrl || '',
      roomTag: room.roomTag || '',
      description: room.description || '',
      announcement: room.announcement || '',
      hostId: room.hostId?._id?.toString?.() || room.hostId?.toString?.() || '',
      host: room.hostId || null,
      isPermanent: !!room.isPermanent,
      visibility: room.visibility || 'public',
      speakerCount: Array.isArray(room.speakers) ? room.speakers.length : 0,
      audienceCount: Array.isArray(room.audience) ? room.audience.length : 0,
      createdAt: room.createdAt,
      lastHeartbeatAt: room.lastHeartbeatAt,
    }));

    const formattedVideoRooms = videoRooms.map(room => {
      const hostId = room.hostId?.toString?.() || String(room.hostId || '');
      const host = videoHostMap.get(hostId) || null;
      const slots = Array.isArray(room.slots) ? room.slots : [];
      const speakerCount = slots.filter(slot => slot?.uid !== null && slot?.uid !== undefined).length;
      const presenceCount = roomPresence[room.channelName] ? Object.keys(roomPresence[room.channelName]).length : 0;

      return {
        id: room._id?.toString?.() || String(room._id),
        _id: room._id?.toString?.() || String(room._id),
        roomId: room.channelName,
        channelName: room.channelName,
        roomMode: 'video',
        title: room.title || 'Glix Live Room',
        hasPassword: !!room.roomPassword,
        coverUrl: room.coverUrl || '',
        roomTag: room.roomTag || '',
        description: room.description || '',
        announcement: room.announcement || '',
        hostId,
        host,
        slots,
        speakerCount,
        audienceCount: Math.max(0, presenceCount - speakerCount),
        createdAt: room.createdAt,
        lastHeartbeatAt: room.lastHeartbeatAt,
      };
    });

    const rooms = [...formattedAudioRooms, ...formattedVideoRooms]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return res.status(200).json({ success: true, rooms });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
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
      _id: room._id,
      roomId: room._id,
      roomMode: 'audio',
      title: room.title,
      hasPassword: !!room.roomPassword,
      coverUrl: room.coverUrl || '',
      roomTag: room.roomTag || '',
      host: room.hostId,
      hostId: room.hostId?._id || room.hostId,
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
      user.lastLogin = new Date();
      await user.save();
      await ensurePermanentAudioRoomForUser(user._id);
      const token = await createOfficialSession(user._id);
      return res.status(200).json({
        success: true,
        message: 'Login successful!',
        token,
        user: serializeOfficialUser(user)
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = password ? await bcrypt.hash(password, salt) : null;
    const newUser = new User({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      profilePic: profilePic || '',
      ...(googleId ? { googleId } : {}),
      glixId: await createUniqueUserPublicId()
    });
    await newUser.save();
    await ensurePermanentAudioRoomForUser(newUser._id);
    const token = await createOfficialSession(newUser._id);
    return res.status(201).json({
      success: true,
      message: 'Registered!',
      token,
      user: serializeOfficialUser(newUser)
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

app.get('/room/background-themes', (req, res) => {
  const themes = ROOM_BACKGROUND_THEMES
    .filter(theme => theme?.id && theme?.url)
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));

  return res.status(200).json({ success: true, themes });
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
    const { userId, itemId, itemKey, paymentCurrency } = req.body;
    const requestedItemKey = String(itemKey || '').trim();
    const hasValidItemId = mongoose.Types.ObjectId.isValid(itemId);
    const hasValidItemKey = /^[a-zA-Z0-9_-]+$/.test(requestedItemKey);
    if (!mongoose.Types.ObjectId.isValid(userId) || (!hasValidItemId && !hasValidItemKey)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid purchase request' });
    }

    await ensureDefaultStoreItems();
    const item = hasValidItemId
      ? await StoreItem.findById(itemId).session(session)
      : await StoreItem.findOne({ itemKey: requestedItemKey }).session(session);
    if (!item || !item.isActive) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Store item not found' });
    }

    const isVipPurchase = item.type === 'vip' || item.isVipItem;
    const existing = await UserStoreItem.findOne({ userId, itemKey: item.itemKey }).session(session);
    if (!isVipPurchase && existing && (!existing.expiresAt || existing.expiresAt > new Date())) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Item already owned' });
    }

    const requestedCurrency = paymentCurrency === 'daimon' || paymentCurrency === 'chang' ? paymentCurrency : null;
    const chargeCurrency = requestedCurrency && isVipPurchase ? requestedCurrency : item.currency || 'chang';
    const currencyLabel = chargeCurrency === 'daimon' ? 'diamonds' : 'coins';
    const price = Number(item.price || 0);

    const user = await User.findOneAndUpdate(
      { _id: userId, [chargeCurrency]: { $gte: price } },
      { $inc: { [chargeCurrency]: -price } },
      { new: true, session }
    );

    if (!user) throw new Error(`Insufficient ${currencyLabel}`);

    let expiresAt = getStoreExpiry(item);
    if (isVipPurchase) {
      const durationDays = getStoreDurationDays(item);
      const baseDate = existing?.expiresAt && existing.expiresAt > new Date() ? new Date(existing.expiresAt) : new Date();
      if (durationDays && durationDays > 0) {
        expiresAt = new Date(baseDate);
        expiresAt.setDate(expiresAt.getDate() + durationDays);
      }
    }

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

    if (isVipPurchase) {
      const vipBadgeUrl = item.badgeUrl || item.imageUrl || item.assetKey || '';
      const vipFrameUrl = item.frameUrl || item.equipValue || '';
      const vipEntryVideoUrl = item.entryVideoUrl || '';
      await User.findByIdAndUpdate(
        userId,
        {
          $set: {
            isVip: true,
            vipExpiresAt: expiresAt,
            vipBadgeUrl,
            vipItemKey: item.itemKey,
            frameUrl: vipFrameUrl || user.frameUrl || '',
            entryVideoUrl: vipEntryVideoUrl || user.entryVideoUrl || ''
          }
        },
        { session }
      );
    }

    await session.commitTransaction();
    const wallet = await getStoreWallet(userId);
    return res.status(200).json({
      success: true,
      message: 'Purchase successful',
      wallet,
      paymentCurrency: chargeCurrency,
    });
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

    if (task.key === NEW_HOST_LIVE_REWARD_KEY) {
      const user = await User.findById(userId).select('role createdAt hostStatus hostRegistration');
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const rewardStatus = await getNewHostLiveRewardStatus(user, start, end, dayKey, now);
      if (!rewardStatus.canClaim) {
        return res.status(400).json({
          success: false,
          message: rewardStatus.eligible
            ? rewardStatus.claimsToday >= rewardStatus.maxClaimsPerDay
              ? 'Daily host live bonus limit reached'
              : 'Stream at least 60 minutes to claim this reward'
            : rewardStatus.description,
          hostLiveReward: rewardStatus
        });
      }

      const claimedHourBlock = rewardStatus.claimsToday + 1;
      const claimKey = `${userId}:${task.key}:${dayKey}:${claimedHourBlock}`;
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        await HostLiveRewardClaim.create([{
          hostId: userId,
          dayKey,
          claimKey,
          claimedHourBlock,
          amount: NEW_HOST_LIVE_REWARD_AMOUNT
        }], { session });

        await RewardClaim.create([{
          userId,
          taskKey: task.key,
          claimKey,
          rewardType: task.rewardType,
          amount: NEW_HOST_LIVE_REWARD_AMOUNT
        }], { session });

        await User.findByIdAndUpdate(
          userId,
          { $inc: { chang: NEW_HOST_LIVE_REWARD_AMOUNT } },
          { session }
        );

        await session.commitTransaction();
      } catch (error) {
        await session.abortTransaction();
        if (error.code === 11000) {
          return res.status(400).json({ success: false, message: 'Host live bonus already claimed for this hour block' });
        }
        throw error;
      } finally {
        session.endSession();
      }

      const dashboard = await buildRewardDashboard(userId);
      return res.status(200).json({
        ...dashboard,
        message: `Claimed ${NEW_HOST_LIVE_REWARD_AMOUNT} coins`
      });
    }

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

const PUBLIC_USER_FIELDS = 'name email profilePic glixId googleId createdAt lastLogin followersCount followingCount daimon chang sentGiftCoins frameUrl entryVideoUrl isVip vipExpiresAt vipBadgeUrl vipItemKey settings blacklistedUsers gender birthday countryRegion voiceSignature signature albumPhotos role roles accountStatus hostStatus agencyStatus agencyCode coinSellerStatus adminAccessRequest';

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


const uploadUserImage = async (userId, image, label) => {
  if (!image?.base64) return '';
  const mimeType = image.type || 'image/jpeg';
  const dataUri = String(image.base64).startsWith('data:')
    ? image.base64
    : `data:${mimeType};base64,${image.base64}`;
  const result = await cloudinary.uploader.upload(dataUri, {
    folder: `user-media/${userId}`,
    public_id: `${label}-${Date.now()}`,
    resource_type: 'image',
  });
  return result.secure_url || '';
};

app.post('/settings/:userId/profile-picture', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (!req.body?.image?.base64) return res.status(400).json({ success: false, message: 'Profile image is required' });

    const profilePic = await uploadUserImage(userId, req.body.image, 'profile-picture');
    const user = await User.findByIdAndUpdate(userId, { $set: { profilePic } }, { new: true }).select(PUBLIC_USER_FIELDS);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/profile-name', async (req, res) => {
  try {
    const { userId } = req.params;
    const name = String(req.body?.name || '').trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (name.length < 2) return res.status(400).json({ success: false, message: 'Name must be at least 2 characters' });

    const user = await User.findByIdAndUpdate(userId, { $set: { name } }, { new: true }).select(PUBLIC_USER_FIELDS);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/profile-info', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const update = {};
    ['gender', 'birthday', 'countryRegion', 'voiceSignature', 'signature'].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        update[key] = typeof req.body[key] === 'string' ? req.body[key].trim() : req.body[key];
      }
    });

    const user = await User.findByIdAndUpdate(userId, { $set: update }, { new: true, runValidators: true }).select(PUBLIC_USER_FIELDS);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/settings/:userId/album-photo', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (!req.body?.image?.base64) return res.status(400).json({ success: false, message: 'Album image is required' });

    const user = await User.findById(userId).select('albumPhotos');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if ((user.albumPhotos || []).length >= 10) return res.status(400).json({ success: false, message: 'Album limit is 10 photos' });

    const photoUrl = await uploadUserImage(userId, req.body.image, 'album-photo');
    user.albumPhotos = [...(user.albumPhotos || []), photoUrl];
    await user.save();
    const updated = await User.findById(userId).select(PUBLIC_USER_FIELDS);
    return res.status(201).json({ success: true, user: updated, photoUrl });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/settings/:userId/album-photo', async (req, res) => {
  try {
    const { userId } = req.params;
    const photoUrl = String(req.body?.photoUrl || '').trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (!photoUrl) return res.status(400).json({ success: false, message: 'Photo URL is required' });

    const user = await User.findByIdAndUpdate(userId, { $pull: { albumPhotos: photoUrl } }, { new: true }).select(PUBLIC_USER_FIELDS);
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
      HostLiveRewardClaim.deleteMany({ hostId: userId }, { session }),
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
      .populate('followerId', 'name profilePic glixId daimon sentGiftCoins countryRegion')
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
        sentGiftCoins: row.followerId.sentGiftCoins || 0,
        countryRegion: row.followerId.countryRegion || '',
        followedAt: row.createdAt
      }));

    return res.status(200).json({ success: true, fans });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});


const serializeProfileListUser = (user, viewerFollowingIds = new Set(), extra = {}) => ({
  id: user?._id?.toString?.() || user?.id?.toString?.() || '',
  name: user?.name || 'User',
  profilePic: user?.profilePic || '',
  glixId: user?.glixId || '',
  daimon: Number(user?.daimon || 0),
  sentGiftCoins: Number(user?.sentGiftCoins || 0),
  countryRegion: user?.countryRegion || '',
  isFollowing: viewerFollowingIds.has(String(user?._id || user?.id || '')),
  ...extra,
});

const getViewerFollowingIds = async (viewerId) => {
  if (!mongoose.Types.ObjectId.isValid(viewerId)) return new Set();
  const rows = await Follow.find({ followerId: viewerId }).select('followingId').lean();
  return new Set(rows.map(row => String(row.followingId)));
};

app.post('/profile/:userId/visit', async (req, res) => {
  try {
    const { userId } = req.params;
    const visitorId = String(req.body?.visitorId || '').trim();

    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(visitorId)) {
      return res.status(400).json({ success: false, message: 'Invalid profile visit request' });
    }

    if (String(userId) === String(visitorId)) {
      return res.status(200).json({ success: true, skipped: true });
    }

    await ProfileVisit.findOneAndUpdate(
      { profileUserId: userId, visitorId },
      { $set: { visitedAt: new Date() }, $inc: { visitCount: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/profile/:userId/visitors', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const viewerId = String(req.query.viewerId || '').trim();

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const profileUser = await User.findById(userId).select('settings').lean();
    if (!profileUser) return res.status(404).json({ success: false, message: 'User not found' });

    const visible = profileUser.settings?.showProfileVisits !== false || String(viewerId) === String(userId);
    if (!visible) {
      return res.status(200).json({ success: true, visible: false, visitors: [], totalVisitors: 0 });
    }

    const [rows, totalVisitors, viewerFollowingIds] = await Promise.all([
      ProfileVisit.find({ profileUserId: userId })
        .populate('visitorId', 'name profilePic glixId daimon sentGiftCoins countryRegion')
        .sort({ visitedAt: -1 })
        .limit(limit)
        .lean(),
      ProfileVisit.countDocuments({ profileUserId: userId }),
      getViewerFollowingIds(viewerId),
    ]);

    const visitors = rows
      .filter(row => row.visitorId)
      .map(row => serializeProfileListUser(row.visitorId, viewerFollowingIds, {
        visitedAt: row.visitedAt,
        visitCount: row.visitCount || 1,
      }));

    return res.status(200).json({ success: true, visible: true, visitors, totalVisitors });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/profile/:userId/following', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const viewerId = String(req.query.viewerId || '').trim();

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const [rows, viewerFollowingIds] = await Promise.all([
      Follow.find({ followerId: userId })
        .populate('followingId', 'name profilePic glixId daimon sentGiftCoins countryRegion')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      getViewerFollowingIds(viewerId),
    ]);

    const users = rows
      .filter(row => row.followingId)
      .map(row => serializeProfileListUser(row.followingId, viewerFollowingIds, { followedAt: row.createdAt }));

    return res.status(200).json({ success: true, users });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/profile/:userId/followers', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const viewerId = String(req.query.viewerId || '').trim();

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const [rows, viewerFollowingIds] = await Promise.all([
      Follow.find({ followingId: userId })
        .populate('followerId', 'name profilePic glixId daimon sentGiftCoins countryRegion')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      getViewerFollowingIds(viewerId),
    ]);

    const users = rows
      .filter(row => row.followerId)
      .map(row => serializeProfileListUser(row.followerId, viewerFollowingIds, { followedAt: row.createdAt }));

    return res.status(200).json({ success: true, users });
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

const APP_ROLE_VALUES = ['user', 'host', 'agency', 'manager', 'admin', 'coin_seller', 'super_admin'];

const normalizeUserRoles = (user = {}) => {
  const plain = typeof user.toObject === 'function' ? user.toObject() : user;
  const roleSet = new Set(['user']);
  const addRole = (role) => {
    const clean = String(role || '').toLowerCase();
    if (APP_ROLE_VALUES.includes(clean)) roleSet.add(clean);
  };

  (Array.isArray(plain?.roles) ? plain.roles : []).forEach(addRole);
  addRole(plain?.role);
  if (plain?.hostStatus === 'approved' || plain?.hostRegistration?.status === 'approved') addRole('host');
  if (plain?.agencyStatus === 'approved' || plain?.agencyRegistration?.status === 'approved') addRole('agency');
  if (plain?.coinSellerStatus === 'approved' || plain?.coinSellerRegistration?.status === 'approved') addRole('coin_seller');
  if (plain?.adminAccessRequest?.status === 'approved') addRole(plain.adminAccessRequest.requestedRole);
  return Array.from(roleSet);
};

const hasUserRole = (user, role) => normalizeUserRoles(user).includes(String(role || '').toLowerCase());

const addUserRole = (user, role) => {
  if (!user) return;
  const roles = normalizeUserRoles(user);
  const clean = String(role || '').toLowerCase();
  if (APP_ROLE_VALUES.includes(clean) && !roles.includes(clean)) roles.push(clean);
  user.roles = roles;
};

const removeUserRole = (user, role) => {
  if (!user) return;
  const clean = String(role || '').toLowerCase();
  user.roles = normalizeUserRoles(user).filter(item => item === 'user' || item !== clean);
};

const officialUserProjection = 'name email profilePic glixId role roles accountStatus createdAt lastLogin chang daimon sentGiftCoins hostStatus agencyStatus coinSellerStatus sellerBalance sellerTotalSold adminNote';
const officialAccountProjection = 'name email role status permissions sourceUserId note rejectionReason createdBy reviewedBy reviewedAt createdAt updatedAt lastLogin';

const serializeOfficialUser = (user) => {
  if (!user) return null;
  const plain = typeof user.toObject === 'function' ? user.toObject() : user;
  const { password, passwordResetOtpHash, passwordResetOtpExpiresAt, passwordResetOtpRequestedAt, passwordResetOtpAttempts, ...safe } = plain;
  if (safe._id && !safe.id) safe.id = safe._id.toString();
  safe.roles = normalizeUserRoles(safe);
  return safe;
};

const serializeOfficialAccount = (account) => serializeOfficialUser(account);

const createOfficialSession = async (userId, options = {}) => {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionPayload = {
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + OFFICIAL_SESSION_MS),
  };
  if (options.officialUserId) sessionPayload.officialUserId = options.officialUserId;
  else sessionPayload.userId = userId;
  await AuthSession.create(sessionPayload);
  return token;
};

app.post('/auth/app-session', async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const user = await User.findById(userId).select(officialUserProjection);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
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

const requireOfficial = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) return res.status(401).json({ success: false, message: 'Official token missing' });

    const session = await AuthSession.findOne({
      tokenHash: hashToken(token),
      expiresAt: { $gt: new Date() },
    }).populate('officialUserId');

    const officialUser = session?.officialUserId;
    if (!officialUser) return res.status(401).json({ success: false, message: 'Official session expired' });
    if (officialUser.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only the Super Admin can access the Official Portal' });
    }
    if ((officialUser.status || 'pending') !== 'active') {
      return res.status(403).json({ success: false, message: `Official account is ${officialUser.status}` });
    }

    req.officialUser = officialUser;
    session.lastUsedAt = new Date();
    session.save().catch(() => {});
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || 'Official auth failed' });
  }
};

const detectGiftMediaType = (value = '') => {
  const source = String(value || '').toLowerCase();
  if (source.includes('video/') || source.endsWith('.mp4') || source.includes('/video/upload/')) return 'mp4';
  if (source.includes('image/gif') || source.endsWith('.gif')) return 'gif';
  return 'gif';
};

const serializeGiftCatalogItem = (gift = {}) => {
  const id = gift._id?.toString?.() || String(gift._id || '');
  return {
    id,
    _id: id,
    name: gift.name || 'Gift',
    category: gift.category || 'Popular',
    tab: gift.category || 'Popular',
    price: Number(gift.price || 0),
    mediaType: gift.mediaType || detectGiftMediaType(gift.animationUrl),
    animationUrl: gift.animationUrl || '',
    icon: gift.animationUrl || '',
    thumbnailUrl: gift.thumbnailUrl || '',
    thumbnail: gift.thumbnailUrl || '',
    isLuckyGift: !!gift.isLuckyGift,
    luckyReturnChance: Number(gift.luckyReturnChance || 0),
    isActive: gift.isActive !== false,
    sortOrder: Number(gift.sortOrder || 0),
    createdAt: gift.createdAt,
    updatedAt: gift.updatedAt,
  };
};

const getCloudinaryVideoThumbnail = (videoUrl = '') => {
  if (typeof videoUrl !== 'string' || !videoUrl.includes('/video/upload/')) return '';
  return videoUrl
    .replace('/video/upload/', '/video/upload/so_0,w_360,h_360,c_fill,q_auto/')
    .replace(/\.[a-z0-9]+($|\?)/i, '.jpg$1');
};

const uploadGiftAsset = async (dataUri, folder, resourceType = 'auto') => {
  const cleanDataUri = typeof dataUri === 'string' ? dataUri.trim() : '';
  if (!cleanDataUri) return { url: '', publicId: '' };

  const result = await cloudinary.uploader.upload(cleanDataUri, {
    folder,
    resource_type: resourceType,
    overwrite: false,
  });

  return {
    url: result.secure_url || result.url || '',
    publicId: result.public_id || '',
  };
};

const getGiftCatalogPayload = async (body = {}, existing = null, officialUserId = null) => {
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('Gift name is required.');

  const price = Number(body.price ?? existing?.price ?? 0);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Gift price must be greater than 0.');

  const mediaType = String(body.mediaType || detectGiftMediaType(body.animationData || body.animationUrl || existing?.animationUrl || '')).toLowerCase() === 'mp4'
    ? 'mp4'
    : 'gif';

  const uploadedAnimation = body.animationData
    ? await uploadGiftAsset(body.animationData, `official-gifts/${mediaType}`, mediaType === 'mp4' ? 'video' : 'image')
    : { url: '', publicId: '' };
  const uploadedThumbnail = body.thumbnailData
    ? await uploadGiftAsset(body.thumbnailData, 'official-gifts/thumbnails', 'image')
    : { url: '', publicId: '' };

  const animationUrl = uploadedAnimation.url || String(body.animationUrl || existing?.animationUrl || '').trim();
  if (!animationUrl) throw new Error('Gift animation file or URL is required.');

  const thumbnailUrl = uploadedThumbnail.url ||
    String(body.thumbnailUrl || existing?.thumbnailUrl || '').trim() ||
    (mediaType === 'mp4' ? getCloudinaryVideoThumbnail(animationUrl) : animationUrl);

  return {
    name,
    price,
    category: String(body.category ?? existing?.category ?? 'Popular').trim() || 'Popular',
    mediaType,
    animationUrl,
    thumbnailUrl,
    publicId: uploadedAnimation.publicId || existing?.publicId || '',
    thumbnailPublicId: uploadedThumbnail.publicId || existing?.thumbnailPublicId || '',
    isLuckyGift: body.isLuckyGift !== undefined ? !!body.isLuckyGift : !!existing?.isLuckyGift,
    luckyReturnChance: Number(body.luckyReturnChance ?? existing?.luckyReturnChance ?? 0),
    isActive: body.isActive !== undefined ? !!body.isActive : existing?.isActive !== false,
    sortOrder: Number(body.sortOrder ?? existing?.sortOrder ?? 0),
    uploadedBy: existing?.uploadedBy || officialUserId || null,
  };
};

app.get('/gifts', async (req, res) => {
  try {
    const gifts = await GiftCatalog.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    return res.json({ success: true, gifts: gifts.map(serializeGiftCatalogItem) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/gifts', requireOfficial, async (req, res) => {
  try {
    const includeInactive = req.query?.includeInactive === 'true';
    const query = includeInactive ? {} : { isActive: true };
    const gifts = await GiftCatalog.find(query)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    return res.json({ success: true, gifts: gifts.map(serializeGiftCatalogItem) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/gifts', requireOfficial, async (req, res) => {
  try {
    const payload = await getGiftCatalogPayload(req.body, null, req.officialUser?._id || null);
    const gift = await GiftCatalog.create(payload);
    return res.status(201).json({ success: true, gift: serializeGiftCatalogItem(gift) });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

app.patch('/admin/gifts/:giftId', requireOfficial, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.giftId)) {
      return res.status(400).json({ success: false, message: 'Invalid gift id.' });
    }
    const gift = await GiftCatalog.findById(req.params.giftId);
    if (!gift) return res.status(404).json({ success: false, message: 'Gift not found.' });

    const payload = await getGiftCatalogPayload(req.body, gift, req.officialUser?._id || null);
    Object.assign(gift, payload);
    await gift.save();
    return res.json({ success: true, gift: serializeGiftCatalogItem(gift) });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

const findUserByIdentifier = async (identifier) => {
  const clean = String(identifier || '').trim();
  if (!clean) return null;
  const or = [{ email: clean.toLowerCase() }, { glixId: clean }];
  if (mongoose.Types.ObjectId.isValid(clean)) or.push({ _id: clean });
  return User.findOne({ $or: or });
};

const getAuthenticatedAppUser = async (req) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;

  const session = await AuthSession.findOne({
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() },
  }).populate('userId');

  const user = session?.userId || null;
  if (user) {
    session.lastUsedAt = new Date();
    session.save().catch(() => {});
  }
  return user;
};

const requireAppUser = async (req, res, next) => {
  try {
    const user = await getAuthenticatedAppUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Please login again.' });
    if ((user.accountStatus || 'active') !== 'active') {
      return res.status(403).json({ success: false, message: `Your account is ${user.accountStatus}` });
    }
    req.authUser = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || 'Auth failed' });
  }
};

const requireAppRole = (...allowedRoles) => async (req, res, next) => {
  try {
    const user = await getAuthenticatedAppUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Please login again.' });
    if ((user.accountStatus || 'active') !== 'active') {
      return res.status(403).json({ success: false, message: `Your account is ${user.accountStatus}` });
    }

    const normalizedAllowedRoles = allowedRoles.map(item => String(item || '').toLowerCase());
    const userRoles = normalizeUserRoles(user);
    if (!userRoles.includes('super_admin') && !normalizedAllowedRoles.some(role => userRoles.includes(role))) {
      return res.status(403).json({ success: false, message: 'You do not have permission for this app dashboard action.' });
    }

    req.authUser = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || 'Auth failed' });
  }
};

const TOPLINER_ROLE_OPTIONS = {
  host: ['agency'],
  agency: ['admin'],
  admin: ['manager'],
  manager: ['super_admin'],
};

const buildToplinerUser = (user, roleOverride = '') => ({
  _id: user._id?.toString?.() || String(user._id || ''),
  id: user._id?.toString?.() || String(user._id || ''),
  name: user.name || roleOverride || 'Topliner',
  glixId: user.glixId || '',
  profilePic: user.profilePic || '',
  role: roleOverride || normalizeUserRoles(user).find(role => role !== 'user') || user.role || 'user',
  agencyCode: user.agencyCode || user.agencyRegistration?.requestedAgencyCode || '',
});

const getToplinerSelection = async ({ toplinerId, toplinerRole, allowedRoles = [] }) => {
  const cleanRole = String(toplinerRole || '').trim().toLowerCase();
  const cleanId = String(toplinerId || '').trim();

  if (!cleanId && (!cleanRole || cleanRole === 'official') && allowedRoles.includes('official')) {
    return {
      id: null,
      role: cleanRole || 'official',
      name: 'Official',
      glixId: 'OFFICIAL',
      agencyCode: 'OFFICIAL',
    };
  }

  if (!cleanId) {
    throw new Error('Please select a valid topliner.');
  }

  if (!mongoose.Types.ObjectId.isValid(cleanId)) {
    throw new Error('Please select a valid topliner.');
  }

  const user = await User.findById(cleanId).select('name profilePic glixId role roles agencyStatus agencyCode agencyRegistration adminAccessRequest accountStatus');
  if (!user) throw new Error('Selected topliner was not found.');
  if ((user.accountStatus || 'active') !== 'active') throw new Error('Selected topliner account is not active.');

  const roles = normalizeUserRoles(user);
  const matchedRole = allowedRoles.find(role => roles.includes(role));
  if (!matchedRole || (cleanRole && cleanRole !== matchedRole && !roles.includes(cleanRole))) {
    throw new Error('Selected topliner does not have the required role.');
  }

  const finalRole = cleanRole && allowedRoles.includes(cleanRole) ? cleanRole : matchedRole;
  return {
    id: user._id,
    role: finalRole,
    name: user.name || finalRole,
    glixId: user.glixId || '',
    agencyCode: user.agencyCode || user.agencyRegistration?.requestedAgencyCode || '',
  };
};

app.get('/mobile/topliners', requireAppUser, async (req, res) => {
  try {
    const forRole = String(req.query.forRole || '').trim().toLowerCase();
    const allowedRoles = TOPLINER_ROLE_OPTIONS[forRole] || [];
    if (!allowedRoles.length) return res.status(400).json({ success: false, message: 'Invalid topliner target role.' });

    const queries = allowedRoles.map(role => {
      if (role === 'agency') return { $or: [{ role }, { roles: role }, { agencyStatus: 'approved' }] };
      if (role === 'super_admin') return { $or: [{ role }, { roles: role }] };
      return { $or: [{ role }, { roles: role }, { 'adminAccessRequest.requestedRole': role, 'adminAccessRequest.status': 'approved' }] };
    });

    const users = await User.find({
      accountStatus: { $ne: 'banned' },
      $or: queries,
    })
      .select('name profilePic glixId role roles agencyStatus agencyCode agencyRegistration adminAccessRequest')
      .sort({ role: 1, name: 1 })
      .limit(100)
      .lean();

    const topliners = [];
    if (forRole === 'host' && allowedRoles.includes('official')) {
      topliners.push({
        _id: '',
        id: '',
        name: 'Official',
        glixId: 'OFFICIAL',
        profilePic: '',
        role: 'official',
        agencyCode: 'OFFICIAL',
      });
    }

    users.forEach(user => {
      const roles = normalizeUserRoles(user);
      const role = allowedRoles.find(item => roles.includes(item));
      if (!role) return;
      topliners.push(buildToplinerUser(user, role));
    });

    return res.json({ success: true, topliners });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load topliners.' });
  }
});

const serializeCustomRoomTheme = (theme) => {
  const plain = typeof theme?.toObject === 'function' ? theme.toObject() : theme;
  if (!plain) return null;

  const now = new Date();
  const isExpired = plain.status === 'approved' && plain.expiresAt && new Date(plain.expiresAt) <= now;

  return {
    _id: plain._id?.toString?.() || String(plain._id || ''),
    id: `custom-theme-${plain._id?.toString?.() || String(plain._id || '')}`,
    label: 'Mine',
    url: plain.imageUrl || '',
    imageUrl: plain.imageUrl || '',
    thumbnailUrl: plain.thumbnailUrl || plain.imageUrl || '',
    status: isExpired ? 'expired' : plain.status,
    priceCoins: plain.priceCoins || CUSTOM_ROOM_THEME_PRICE_COINS,
    expiresAt: plain.expiresAt || null,
    rejectionReason: plain.rejectionReason || '',
    createdAt: plain.createdAt || null,
    approvedAt: plain.approvedAt || null,
    isCustom: true,
  };
};

const uploadCustomRoomThemeImage = async (userId, image) => {
  if (!image?.base64) throw new Error('Theme image is required.');
  const mimeType = image.type || image.mime || 'image/jpeg';
  const dataUri = String(image.base64).startsWith('data:')
    ? image.base64
    : `data:${mimeType};base64,${image.base64}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    folder: `room-themes/custom/${userId}`,
    public_id: `theme-${Date.now()}`,
    resource_type: 'image',
    transformation: [
      { width: 1080, height: 1920, crop: 'fill', gravity: 'auto', quality: 'auto', fetch_format: 'auto' },
    ],
  });

  return {
    imageUrl: result.secure_url || '',
    thumbnailUrl: result.secure_url
      ? result.secure_url.replace('/image/upload/', '/image/upload/w_320,h_568,c_fill,q_auto,f_auto/')
      : '',
    publicId: result.public_id || '',
  };
};

const markExpiredCustomRoomThemes = () => (
  CustomRoomTheme.updateMany(
    { status: 'approved', expiresAt: { $lte: new Date() } },
    { $set: { status: 'expired' } }
  ).catch(error => console.log('Custom room theme expiry update failed:', error))
);

app.get('/room-themes/my', requireAppUser, async (req, res) => {
  try {
    await markExpiredCustomRoomThemes();
    const themes = await CustomRoomTheme.find({ userId: req.authUser._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, themes: themes.map(serializeCustomRoomTheme).filter(Boolean) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load your themes.' });
  }
});

app.post('/room-themes/request', requireAppUser, async (req, res) => {
  let deductedUserId = null;
  try {
    const activePendingCount = await CustomRoomTheme.countDocuments({
      userId: req.authUser._id,
      status: { $in: ['pending', 'approved'] },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
    if (activePendingCount >= 5) {
      return res.status(400).json({ success: false, message: 'You can have up to 5 pending or active custom themes.' });
    }

    const uploaded = await uploadCustomRoomThemeImage(req.authUser._id, req.body?.image || req.body);
    const chargedUser = await User.findOneAndUpdate(
      { _id: req.authUser._id, chang: { $gte: CUSTOM_ROOM_THEME_PRICE_COINS } },
      { $inc: { chang: -CUSTOM_ROOM_THEME_PRICE_COINS } },
      { new: true }
    ).select('chang');

    if (!chargedUser) {
      return res.status(400).json({ success: false, message: `You need ${CUSTOM_ROOM_THEME_PRICE_COINS} coins to request a custom room theme.` });
    }
    deductedUserId = req.authUser._id;

    const theme = await CustomRoomTheme.create({
      userId: req.authUser._id,
      imageUrl: uploaded.imageUrl,
      thumbnailUrl: uploaded.thumbnailUrl,
      publicId: uploaded.publicId,
      status: 'pending',
      priceCoins: CUSTOM_ROOM_THEME_PRICE_COINS,
    });

    return res.status(201).json({
      success: true,
      message: 'Theme request submitted for official approval.',
      theme: serializeCustomRoomTheme(theme),
      balance: chargedUser.chang || 0,
    });
  } catch (error) {
    if (deductedUserId) {
      User.findByIdAndUpdate(deductedUserId, { $inc: { chang: CUSTOM_ROOM_THEME_PRICE_COINS } }).catch(() => {});
    }
    return res.status(500).json({ success: false, message: error.message || 'Unable to request custom room theme.' });
  }
});

app.get('/admin/rooms/resolve/:roomId', requireOfficial, async (req, res) => {
  try {
    await closeStaleLiveRooms();
    const room = await resolveRoomForDeepLink(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
    return res.status(200).json({ success: true, ...room });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

const uploadAgencyVerificationImage = async (userId, image, label) => {
  if (!image?.base64) return '';
  const mimeType = image.type || 'image/jpeg';
  const dataUri = String(image.base64).startsWith('data:')
    ? image.base64
    : `data:${mimeType};base64,${image.base64}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    folder: `agency-verification/${userId}`,
    public_id: `${label}-${Date.now()}`,
    resource_type: 'image',
  });

  return result.secure_url || '';
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

const verifyQuantumSignAny = (providedSign, expectedRawValues = []) => (
  expectedRawValues.some(value => verifyQuantumSign(providedSign, value))
);

const providerError = (res, errorCode, errorMsg, data = null) => res.json({
  errorCode,
  errorMsg,
  data,
});

const shouldLogQuantumProvider = () => String(process.env.QUANTUM_NEXUS_DEBUG_LOGS || 'true') !== 'false';

const logQuantumProvider = (event, details = {}) => {
  if (!shouldLogQuantumProvider()) return;
  const safeDetails = { ...details };
  delete safeDetails.token;
  delete safeDetails.sign;
  delete safeDetails.sharedKey;
  console.log(`[QuantumProvider] ${event}`, safeDetails);
};

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

    logQuantumProvider('friends_list_request', {
      uid,
      hasToken: !!token,
      signLength: sign.length,
    });

    if (!sharedKey) {
      logQuantumProvider('friends_list_response', { uid, errorCode: 503, errorMsg: 'Shared key is not configured.' });
      return providerError(res, 503, 'Shared key is not configured.', []);
    }
    if (!uid || !token || !sign) {
      logQuantumProvider('friends_list_response', { uid, errorCode: 400, errorMsg: 'uid, token and sign are required.' });
      return providerError(res, 400, 'uid, token and sign are required.', []);
    }
    if (!verifyQuantumSign(sign, `${uid}${token}${sharedKey}`)) {
      logQuantumProvider('friends_list_response', { uid, errorCode: 401, errorMsg: 'Invalid signature.' });
      return providerError(res, 401, 'Invalid signature.', []);
    }

    const user = await validateQuantumUserSession(uid, token);
    if (!user) {
      logQuantumProvider('friends_list_response', { uid, errorCode: 401, errorMsg: 'Invalid user session.' });
      return providerError(res, 401, 'Invalid user session.', []);
    }

    const friendIds = await resolveQuantumFriendIds(uid);
    if (!friendIds.length) {
      logQuantumProvider('friends_list_response', { uid, errorCode: 0, friendCount: 0 });
      return res.json({ errorCode: 0, errorMsg: 'Success', data: [] });
    }

    const friends = await User.find({ _id: { $in: friendIds } }).select('_id name glixId profilePic').lean();
    logQuantumProvider('friends_list_response', { uid, errorCode: 0, friendCount: friends.length });
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
    logQuantumProvider('friends_list_response', { errorCode: 500, errorMsg: error.message });
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

    logQuantumProvider('user_info_request', {
      gameId,
      uid,
      roomId,
      hasToken: !!token,
      signLength: sign.length,
    });

    if (!sharedKey) {
      logQuantumProvider('user_info_response', { gameId, uid, roomId, errorCode: 503, errorMsg: 'Shared key is not configured.' });
      return providerError(res, 503, 'Shared key is not configured.', null);
    }
    if (!gameId || !uid || !token || !sign) {
      logQuantumProvider('user_info_response', { gameId, uid, roomId, errorCode: 400, errorMsg: 'gameId, uid, token and sign are required.' });
      return providerError(res, 400, 'gameId, uid, token and sign are required.', null);
    }
    if (!verifyQuantumSignAny(sign, [
      `${gameId}${uid}${token}${roomId}${sharedKey}`,
      `${gameId}${uid}${token}${sharedKey}`,
    ])) {
      logQuantumProvider('user_info_response', { gameId, uid, roomId, errorCode: 401, errorMsg: 'Invalid signature.' });
      return providerError(res, 401, 'Invalid signature.', null);
    }

    const user = await validateQuantumUserSession(uid, token);
    if (!user) {
      logQuantumProvider('user_info_response', { gameId, uid, roomId, errorCode: 401, errorMsg: 'Invalid user session.' });
      return providerError(res, 401, 'Invalid user session.', null);
    }

    logQuantumProvider('user_info_response', { gameId, uid, roomId, errorCode: 0, coin: Math.max(0, Math.floor(Number(user?.chang || 0))) });
    return res.json({ errorCode: 0, errorMsg: 'Success', data: serializeQuantumUser(user) });
  } catch (error) {
    console.log('Quantum Nexus user info error:', error.message);
    logQuantumProvider('user_info_response', { errorCode: 500, errorMsg: error.message });
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

    logQuantumProvider('coin_update_request', {
      orderId,
      gameId,
      roundId,
      uid,
      coin,
      type,
      rewardType,
      winId,
      roomId,
      hasToken: !!token,
      signLength: sign.length,
    });

    if (!sharedKey) {
      logQuantumProvider('coin_update_response', { orderId, gameId, uid, errorCode: 503, errorMsg: 'Shared key is not configured.' });
      return providerError(res, 503, 'Shared key is not configured.', null);
    }
    if (!orderId || !gameId || !roundId || !uid || !token || !sign || !Number.isFinite(coin) || coin < 0 || ![1, 2].includes(type) || !Number.isFinite(rewardType)) {
      logQuantumProvider('coin_update_response', { orderId, gameId, uid, errorCode: 400, errorMsg: 'Invalid request parameters.' });
      return providerError(res, 400, 'Invalid request parameters.', null);
    }
    if (!verifyQuantumSign(sign, `${orderId}${gameId}${roundId}${uid}${coin}${type}${rewardType}${token}${winId}${sharedKey}`)) {
      logQuantumProvider('coin_update_response', { orderId, gameId, uid, errorCode: 401, errorMsg: 'Invalid signature.' });
      return providerError(res, 401, 'Invalid signature.', null);
    }

    const duplicateResult = await getExistingGameCoinResult(orderId, res);
    if (duplicateResult) return duplicateResult;

    const user = await validateQuantumUserSession(uid, token);
    if (!user) {
      logQuantumProvider('coin_update_response', { orderId, gameId, uid, errorCode: 401, errorMsg: 'Invalid user session.' });
      return providerError(res, 401, 'Invalid user session.', null);
    }

    const update = type === 1
      ? { $inc: { chang: -coin } }
      : { $inc: { chang: coin } };
    const query = type === 1
      ? { _id: uid, chang: { $gte: coin } }
      : { _id: uid };

    const updatedUser = await User.findOneAndUpdate(query, update, { new: true }).select('_id chang');
    if (!updatedUser) {
      logQuantumProvider('coin_update_response', { orderId, gameId, uid, errorCode: 402, errorMsg: 'Insufficient coins.' });
      return providerError(res, 402, 'Insufficient coins.', null);
    }

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
    emitWalletUpdated(uid, {
      chang: balanceAfter,
      source: type === 1 ? 'game_coin_consume' : 'game_coin_reward',
    });

    logQuantumProvider('coin_update_response', { orderId, gameId, uid, errorCode: 0, coin: balanceAfter });
    return res.json({ errorCode: 0, errorMsg: 'Success', data: { coin: balanceAfter } });
  } catch (error) {
    if (error?.code === 11000 && req.body?.orderId) {
      const existing = await GameCoinTransaction.findOne({ orderId: String(req.body.orderId).trim() }).select('balanceAfter').lean();
      if (existing) return res.json({ errorCode: 0, errorMsg: 'Success', data: { coin: existing.balanceAfter } });
    }
    console.log('Quantum Nexus coin update error:', error.message);
    logQuantumProvider('coin_update_response', { errorCode: 500, errorMsg: error.message });
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

    logQuantumProvider('coin_supplement_request', {
      orderId,
      gameId,
      roundId,
      uid,
      coin,
      rewardType,
      winId,
      roomId,
      signLength: sign.length,
    });

    if (!sharedKey) {
      logQuantumProvider('coin_supplement_response', { orderId, gameId, uid, errorCode: 503, errorMsg: 'Shared key is not configured.' });
      return providerError(res, 503, 'Shared key is not configured.', null);
    }
    if (!orderId || !gameId || !roundId || !uid || !sign || !Number.isFinite(coin) || coin < 0 || !Number.isFinite(rewardType)) {
      logQuantumProvider('coin_supplement_response', { orderId, gameId, uid, errorCode: 400, errorMsg: 'Invalid request parameters.' });
      return providerError(res, 400, 'Invalid request parameters.', null);
    }
    if (!verifyQuantumSign(sign, `${orderId}${gameId}${roundId}${uid}${coin}${rewardType}${winId}${sharedKey}`)) {
      logQuantumProvider('coin_supplement_response', { orderId, gameId, uid, errorCode: 401, errorMsg: 'Invalid signature.' });
      return providerError(res, 401, 'Invalid signature.', null);
    }

    const duplicateResult = await getExistingGameCoinResult(orderId, res);
    if (duplicateResult) return duplicateResult;

    if (!mongoose.Types.ObjectId.isValid(uid)) {
      logQuantumProvider('coin_supplement_response', { orderId, gameId, uid, errorCode: 400, errorMsg: 'Invalid uid.' });
      return providerError(res, 400, 'Invalid uid.', null);
    }
    const updatedUser = await User.findByIdAndUpdate(uid, { $inc: { chang: coin } }, { new: true }).select('_id chang');
    if (!updatedUser) {
      logQuantumProvider('coin_supplement_response', { orderId, gameId, uid, errorCode: 404, errorMsg: 'User not found.' });
      return providerError(res, 404, 'User not found.', null);
    }

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
    emitWalletUpdated(uid, {
      chang: balanceAfter,
      source: 'game_coin_supplement',
    });

    logQuantumProvider('coin_supplement_response', { orderId, gameId, uid, errorCode: 0, coin: balanceAfter });
    return res.json({ errorCode: 0, errorMsg: 'Success', data: { coin: balanceAfter } });
  } catch (error) {
    if (error?.code === 11000 && req.body?.orderId) {
      const existing = await GameCoinTransaction.findOne({ orderId: String(req.body.orderId).trim() }).select('balanceAfter').lean();
      if (existing) return res.json({ errorCode: 0, errorMsg: 'Success', data: { coin: existing.balanceAfter } });
    }
    console.log('Quantum Nexus coin supplement error:', error.message);
    logQuantumProvider('coin_supplement_response', { errorCode: 500, errorMsg: error.message });
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


app.get('/users/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ success: true, users: [] });
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const users = await User.find({
      $or: [
        { name: { $regex: escaped, $options: 'i' } },
        { glixId: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ],
    })
      .select('name profilePic glixId daimon sentGiftCoins countryRegion')
      .limit(20)
      .lean();

    return res.json({
      success: true,
      users: users.map(user => ({
        id: user._id.toString(),
        name: user.name || 'User',
        profilePic: user.profilePic || '',
        glixId: user.glixId || '',
        daimon: user.daimon || 0,
        sentGiftCoins: user.sentGiftCoins || 0,
        countryRegion: user.countryRegion || '',
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/users/fcm-token', async (req, res) => {
  try {
    const user = await getAuthenticatedAppUser(req);
    const userId = String(req.body?.userId || user?._id || '').trim();
    const token = String(req.body?.fcmToken || req.body?.token || '').trim();
    const platform = ['android', 'ios', 'web'].includes(req.body?.platform) ? req.body.platform : 'unknown';

    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (!token) return res.status(400).json({ success: false, message: 'FCM token is required' });

    await User.updateOne(
      { _id: userId, 'fcmTokens.token': token },
      { $set: { 'fcmTokens.$.platform': platform, 'fcmTokens.$.updatedAt': new Date() } }
    );
    await User.updateOne(
      { _id: userId, 'fcmTokens.token': { $ne: token } },
      { $push: { fcmTokens: { token, platform, updatedAt: new Date() } } }
    );

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    const officialUser = await OfficialUser.findOne({ email });
    if (!officialUser || !officialUser.password) return res.status(401).json({ success: false, message: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, officialUser.password);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid email or password' });

    if (officialUser.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only the Super Admin can access the Official Portal' });
    }
    if ((officialUser.status || 'pending') !== 'active') {
      return res.status(403).json({ success: false, message: `Your Official Portal account is ${officialUser.status}. Please wait for approval.` });
    }

    officialUser.lastLogin = new Date();
    await officialUser.save();

    const token = await createOfficialSession(null, { officialUserId: officialUser._id });
    return res.json({ success: true, token, user: serializeOfficialAccount(officialUser) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/auth/forgot-password', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const officialUser = await OfficialUser.findOne({ email });
    if (!officialUser || officialUser.role !== 'super_admin') {
      return res.status(404).json({ success: false, message: 'Official account not found' });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    officialUser.passwordResetOtpHash = await bcrypt.hash(otp, 10);
    officialUser.passwordResetOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    officialUser.passwordResetOtpRequestedAt = new Date();
    officialUser.passwordResetOtpAttempts = 0;
    await officialUser.save();

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
    const officialUser = await OfficialUser.findOne({ email });
    if (!officialUser || officialUser.role !== 'super_admin') return res.status(404).json({ success: false, message: 'Official account not found' });
    if (!officialUser.passwordResetOtpHash || !officialUser.passwordResetOtpExpiresAt || officialUser.passwordResetOtpExpiresAt < new Date()) {
      return res.status(400).json({ success: false, message: 'OTP expired. Request a new code.' });
    }
    if ((officialUser.passwordResetOtpAttempts || 0) >= 5) {
      return res.status(429).json({ success: false, message: 'Too many OTP attempts. Request a new code.' });
    }
    const validOtp = await bcrypt.compare(otp, officialUser.passwordResetOtpHash);
    if (!validOtp) {
      officialUser.passwordResetOtpAttempts = (officialUser.passwordResetOtpAttempts || 0) + 1;
      await officialUser.save();
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }
    if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    officialUser.password = await bcrypt.hash(newPassword, 10);
    officialUser.passwordResetOtpHash = '';
    officialUser.passwordResetOtpExpiresAt = null;
    officialUser.passwordResetOtpRequestedAt = null;
    officialUser.passwordResetOtpAttempts = 0;
    await officialUser.save();
    await AuthSession.deleteMany({ officialUserId: officialUser._id });
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

    const existingOfficial = await OfficialUser.findOne({ email });
    if (existingOfficial) {
      if (existingOfficial.status === 'rejected') {
        existingOfficial.name = name;
        existingOfficial.password = await bcrypt.hash(password, 10);
        existingOfficial.role = requestedRole;
        existingOfficial.status = 'pending';
        existingOfficial.note = note;
        existingOfficial.rejectionReason = '';
        existingOfficial.reviewedBy = null;
        existingOfficial.reviewedAt = null;
        await existingOfficial.save();
        return res.json({ success: true, message: 'Official access request submitted' });
      }
      return res.status(409).json({ success: false, message: `Official account already exists with status ${existingOfficial.status}` });
    }

    const hasActiveSuperAdmin = await OfficialUser.exists({ role: 'super_admin', status: 'active' });
    const status = hasActiveSuperAdmin ? 'pending' : 'active';
    const officialUser = await OfficialUser.create({
      name,
      email,
      password: await bcrypt.hash(password, 10),
      role: hasActiveSuperAdmin ? requestedRole : 'super_admin',
      status,
      note,
      reviewedAt: status === 'active' ? new Date() : null,
    });

    return res.json({
      success: true,
      message: status === 'active'
        ? 'First Official Super Admin created. You can sign in now.'
        : 'Official access request submitted',
      account: serializeOfficialAccount(officialUser),
    });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, message: 'Official email already exists' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/access/request', async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const requestedRole = String(req.body?.requestedRole || '').trim();
    const note = String(req.body?.note || '').trim();
    const toplinerId = String(req.body?.toplinerId || '').trim();
    const toplinerRole = String(req.body?.toplinerRole || '').trim().toLowerCase();

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }
    if (!['admin', 'manager'].includes(requestedRole)) {
      return res.status(400).json({ success: false, message: 'Only admin or manager can be requested from the app' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (hasUserRole(user, requestedRole)) {
      return res.status(400).json({ success: false, message: `You already have ${requestedRole} access` });
    }
    if (user.adminAccessRequest?.status === 'pending' && user.adminAccessRequest?.requestedRole === requestedRole) {
      return res.status(409).json({ success: false, message: 'This request is already pending' });
    }

    const topliner = await getToplinerSelection({
      toplinerId,
      toplinerRole,
      allowedRoles: TOPLINER_ROLE_OPTIONS[requestedRole] || [],
    });

    user.adminAccessRequest = {
      requestedRole,
      status: 'pending',
      note,
      toplinerId: topliner.id,
      toplinerRole: topliner.role,
      toplinerName: topliner.name,
      toplinerGlixId: topliner.glixId,
      rejectionReason: '',
      reviewedBy: null,
      reviewedAt: null,
      requestedAt: new Date(),
    };
    await user.save();

    return res.json({
      success: true,
      message: `Request submitted for ${topliner.name || 'topliner'} approval.`,
      adminAccessRequest: user.adminAccessRequest,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});
app.get('/admin/dashboard', requireOfficial, async (req, res) => {
  try {
    await closeStaleLiveRooms();
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    const [totalUsers, activeUsers, suspendedUsers, pendingHosts, pendingAgencies, pendingWithdrawals, pendingRoomThemes, liveAudioRooms, liveVideoRooms, weeklyGiftAgg] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ accountStatus: 'active' }),
      User.countDocuments({ accountStatus: { $in: ['suspended', 'banned'] } }),
      User.countDocuments({ hostStatus: 'pending' }),
      User.countDocuments({ agencyStatus: 'pending' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      CustomRoomTheme.countDocuments({ status: 'pending' }),
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
        pendingRoomThemes,
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

app.get('/admin/room-themes/requests', requireOfficial, async (req, res) => {
  try {
    await markExpiredCustomRoomThemes();
    const status = String(req.query.status || 'pending').trim();
    const query = status && status !== 'all' ? { status } : {};
    const themes = await CustomRoomTheme.find(query)
      .populate('userId', 'name email glixId profilePic chang')
      .populate('approvedBy', 'name email role')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({
      success: true,
      requests: themes.map(theme => ({
        ...serializeCustomRoomTheme(theme),
        user: theme.userId ? {
          _id: theme.userId._id,
          name: theme.userId.name,
          email: theme.userId.email,
          glixId: theme.userId.glixId,
          profilePic: theme.userId.profilePic,
          chang: theme.userId.chang,
        } : null,
        approvedBy: theme.approvedBy || null,
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load room theme requests.' });
  }
});

app.patch('/admin/room-themes/requests/:themeId', requireOfficial, async (req, res) => {
  try {
    const themeId = String(req.params.themeId || '').replace(/^custom-theme-/, '');
    if (!mongoose.Types.ObjectId.isValid(themeId)) {
      return res.status(400).json({ success: false, message: 'Invalid theme id.' });
    }

    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : '';
    const reason = String(req.body?.reason || req.body?.rejectionReason || '').trim();
    if (!status) return res.status(400).json({ success: false, message: 'Invalid review status.' });

    const theme = await CustomRoomTheme.findById(themeId);
    if (!theme) return res.status(404).json({ success: false, message: 'Theme request not found.' });
    if (theme.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Theme request is already ${theme.status}.` });
    }

    if (status === 'approved') {
      theme.status = 'approved';
      theme.approvedAt = new Date();
      theme.approvedBy = req.officialUser._id;
      theme.expiresAt = new Date(Date.now() + CUSTOM_ROOM_THEME_DURATION_DAYS * 24 * 60 * 60 * 1000);
      theme.rejectionReason = '';
    } else {
      theme.status = 'rejected';
      theme.rejectionReason = reason || 'Rejected by Official Portal.';
      theme.approvedBy = req.officialUser._id;
      theme.approvedAt = new Date();
      theme.expiresAt = null;
      if (!theme.refundedAt) {
        await User.findByIdAndUpdate(theme.userId, { $inc: { chang: theme.priceCoins || CUSTOM_ROOM_THEME_PRICE_COINS } });
        theme.refundedAt = new Date();
      }
    }

    await theme.save();
    const populated = await CustomRoomTheme.findById(theme._id)
      .populate('userId', 'name email glixId profilePic chang')
      .lean();
    return res.json({ success: true, request: serializeCustomRoomTheme(populated) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to review theme request.' });
  }
});

app.get('/admin/users', requireOfficial, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const query = {};
    const andFilters = [];
    if (req.query.role && req.query.role !== 'all') andFilters.push({ $or: [{ role: req.query.role }, { roles: req.query.role }] });
    if (req.query.accountStatus && req.query.accountStatus !== 'all') query.accountStatus = req.query.accountStatus;
    const search = String(req.query.search || '').trim();
    if (search) {
      andFilters.push({ $or: [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { glixId: { $regex: search, $options: 'i' } },
      ] });
    }
    if (andFilters.length) query.$and = andFilters;

    const [total, users] = await Promise.all([
      User.countDocuments(query),
      User.find(query).select(officialUserProjection).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    return res.json({ success: true, users: users.map(serializeOfficialUser), page, pages: Math.max(1, Math.ceil(total / limit)), total });
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

    const write = { $set: update };
    if (update.role && APP_ROLE_VALUES.includes(String(update.role).toLowerCase())) {
      write.$addToSet = { roles: String(update.role).toLowerCase() };
    }
    const user = await User.findByIdAndUpdate(req.params.userId, write, { new: true, runValidators: true }).select(officialUserProjection);
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
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.hostStatus = status;
    user.hostRejectionReason = status === 'rejected' ? String(req.body?.reason || '') : '';
    user.hostRegistration.status = status;
    user.hostRegistration.rejectionReason = user.hostRejectionReason;
    user.hostRegistration.reviewedBy = req.officialUser._id;
    user.hostRegistration.reviewedAt = new Date();

    if (status === 'approved') {
      addUserRole(user, 'host');
      if (user.agencyStatus === 'approved' || hasUserRole(user, 'agency')) {
        user.role = 'agency';
        addUserRole(user, 'agency');
      } else if (!user.role || user.role === 'user') {
        user.role = 'host';
      }
      await linkApprovedHostToAgency(user);
    } else {
      removeUserRole(user, 'host');
    }

    await user.save();
    return res.json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

const AGENCY_CODE_PATTERN = /^[A-Z0-9_-]{4,24}$/;

const normalizeAgencyCode = (value = '') => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

const validateAgencyCode = (agencyCode) => {
  if (!agencyCode) return 'Agency code is required.';
  if (!AGENCY_CODE_PATTERN.test(agencyCode)) {
    return 'Agency code must be 4-24 characters and use only letters, numbers, underscore, or dash.';
  }
  return '';
};

const findAgencyCodeOwner = async (agencyCode, excludeUserId = null) => {
  const query = {
    $or: [
      { agencyCode },
      {
        agencyStatus: { $in: ['pending', 'approved'] },
        'agencyRegistration.requestedAgencyCode': agencyCode,
      },
    ],
  };

  if (excludeUserId && mongoose.Types.ObjectId.isValid(String(excludeUserId))) {
    query._id = { $ne: excludeUserId };
  }

  return User.findOne(query).select('_id name email glixId agencyCode agencyStatus agencyRegistration.requestedAgencyCode').lean();
};

const isOfficialAgencyCode = (agencyCode = '') => {
  const cleanCode = normalizeAgencyCode(agencyCode);
  return !cleanCode || cleanCode === 'OFFICIAL';
};

const findApprovedAgencyByCode = async (agencyCode, excludeUserId = null) => {
  const cleanCode = normalizeAgencyCode(agencyCode);
  if (isOfficialAgencyCode(cleanCode)) return null;

  const query = {
    agencyStatus: 'approved',
    $or: [
      { agencyCode: cleanCode },
      { 'agencyRegistration.requestedAgencyCode': cleanCode },
    ],
  };

  if (excludeUserId && mongoose.Types.ObjectId.isValid(String(excludeUserId))) {
    query._id = { $ne: excludeUserId };
  }

  return User.findOne(query).select('_id agencyCode agencyStatus').lean();
};

const linkApprovedHostToAgency = async (hostUser) => {
  if (!hostUser || hostUser.hostStatus !== 'approved') return null;

  const agencyCode = normalizeAgencyCode(hostUser.hostRegistration?.agencyCode || hostUser.agencyCode || '');
  if (isOfficialAgencyCode(agencyCode)) {
    hostUser.agencyCode = agencyCode || 'OFFICIAL';
    hostUser.agencyId = null;
    if (hostUser.hostRegistration) hostUser.hostRegistration.agencyCode = hostUser.agencyCode;
    return null;
  }

  const agency = await findApprovedAgencyByCode(agencyCode, hostUser._id);
  if (!agency) return null;

  hostUser.agencyId = agency._id;
  hostUser.agencyCode = agency.agencyCode || agencyCode;
  if (hostUser.hostRegistration) hostUser.hostRegistration.agencyCode = hostUser.agencyCode;
  return agency;
};

const backfillApprovedHostsForAgency = async (agencyUser) => {
  if (!agencyUser || agencyUser.agencyStatus !== 'approved') return 0;
  const agencyCode = normalizeAgencyCode(agencyUser.agencyCode || agencyUser.agencyRegistration?.requestedAgencyCode || '');
  if (isOfficialAgencyCode(agencyCode)) return 0;

  const result = await User.updateMany(
    {
      _id: { $ne: agencyUser._id },
      hostStatus: 'approved',
      $or: [
        { agencyCode },
        { 'hostRegistration.agencyCode': agencyCode },
      ],
    },
    {
      $set: {
        agencyId: agencyUser._id,
        agencyCode,
        'hostRegistration.agencyCode': agencyCode,
      },
    }
  );

  return result.modifiedCount ?? result.nModified ?? 0;
};

const buildAgencyHostQuery = (agencyUser) => {
  const agencyCode = normalizeAgencyCode(agencyUser?.agencyCode || agencyUser?.agencyRegistration?.requestedAgencyCode || '');
  const query = {
    _id: { $ne: agencyUser?._id },
    hostStatus: 'approved',
    $or: [{ agencyId: agencyUser?._id }],
  };

  if (!isOfficialAgencyCode(agencyCode)) {
    query.$or.push(
      { agencyCode },
      { 'hostRegistration.agencyCode': agencyCode }
    );
  }

  return query;
};

app.get('/agency/dashboard', requireAppUser, async (req, res) => {
  try {
    const agencyUser = await User.findById(req.authUser._id)
      .select('_id role roles agencyStatus agencyCode agencyRegistration totalHostCoins commissionBalance')
      .lean();

    if (!agencyUser || (!hasUserRole(agencyUser, 'agency') && agencyUser.agencyStatus !== 'approved')) {
      return res.status(403).json({ success: false, message: 'Agency account required.' });
    }

    const hostStats = await User.aggregate([
      { $match: buildAgencyHostQuery(agencyUser) },
      {
        $group: {
          _id: null,
          hostsCount: { $sum: 1 },
          totalHostCoins: { $sum: { $ifNull: ['$totalHostCoins', 0] } },
        },
      },
    ]);

    const month = getCommissionMonthKey();
    const target = await AgencyTarget.findOne({ agencyId: agencyUser._id, month }).lean();
    const aggregateHostCoins = hostStats[0]?.totalHostCoins || 0;

    return res.json({
      success: true,
      stats: {
        hostsCount: hostStats[0]?.hostsCount || 0,
        totalHostCoins: Math.max(agencyUser.totalHostCoins || 0, aggregateHostCoins),
        commissionBalance: agencyUser.commissionBalance || 0,
        currentMonthTarget: target || null,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

const getCommissionMonthKey = (date = new Date()) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

const getCommissionDayKey = (date = new Date()) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getAgencyCommissionTier = (sourceCoins = 0) => {
  const total = Number(sourceCoins || 0);
  return AGENCY_COMMISSION_TIERS.find(tier => total >= tier.min && total < tier.max)
    || AGENCY_COMMISSION_TIERS[0];
};

const getCommissionAmount = (sourceCoins = 0, ratePercent = 0) => {
  const coins = Number(sourceCoins || 0);
  const rate = Number(ratePercent || 0);
  if (!Number.isFinite(coins) || coins <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.floor((coins * rate) / 100);
};

const findApprovedAgencyForCommission = async ({ agencyId = null, agencyCode = '', excludeUserId = null, session = null }) => {
  const cleanCode = normalizeAgencyCode(agencyCode);
  const query = {
    agencyStatus: 'approved',
    $or: [],
  };

  if (agencyId && mongoose.Types.ObjectId.isValid(String(agencyId))) {
    query.$or.push({ _id: agencyId });
  }

  if (!isOfficialAgencyCode(cleanCode)) {
    query.$or.push(
      { agencyCode: cleanCode },
      { 'agencyRegistration.requestedAgencyCode': cleanCode }
    );
  }

  if (!query.$or.length) return null;

  if (excludeUserId && mongoose.Types.ObjectId.isValid(String(excludeUserId))) {
    query._id = { $ne: excludeUserId };
  }

  const request = User.findOne(query).select('_id agencyCode agencyStatus role roles agencyRegistration totalHostCoins');
  if (session) request.session(session);
  return request.lean();
};

const findApprovedRoleUserForCommission = async ({ userId, role, session = null }) => {
  if (!mongoose.Types.ObjectId.isValid(String(userId || ''))) return null;

  const statusField = role === 'agency'
    ? 'agencyStatus'
    : role === 'host'
      ? 'hostStatus'
      : '';
  const query = User.findById(userId).select('_id role roles agencyStatus hostStatus agencyRegistration adminAccessRequest accountStatus totalHostCoins');
  if (session) query.session(session);
  const user = await query.lean();
  if (!user || (user.accountStatus || 'active') !== 'active') return null;

  const roles = normalizeUserRoles(user);
  const hasRole = roles.includes(role)
    || user.role === role
    || (statusField && user[statusField] === 'approved');

  return hasRole ? user : null;
};

const updateCommissionLedger = async ({ beneficiaryId, beneficiaryRole, hostId, sourceCoins, commissionAmount, ratePercent, month, day, session = null }) => {
  if (!beneficiaryId || !hostId || !commissionAmount) return;

  const balanceField = beneficiaryRole === 'admin' ? 'revenueBalance' : 'commissionBalance';

  await Promise.all([
    MonthlyCommission.findOneAndUpdate(
      {
        beneficiaryId,
        beneficiaryRole,
        hostId,
        month,
      },
      {
        $inc: {
          sourceCoins,
          commissionAmount,
        },
        $set: {
          ratePercent,
          status: 'pending',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session }
    ),
    DailyCommission.findOneAndUpdate(
      {
        beneficiaryId,
        beneficiaryRole,
        hostId,
        day,
      },
      {
        $inc: {
          sourceCoins,
          commissionAmount,
        },
        $set: {
          ratePercent,
          status: 'pending',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session }
    ),
    User.findByIdAndUpdate(
      beneficiaryId,
      { $inc: { [balanceField]: commissionAmount } },
      { session }
    ),
  ]);
};

const recordGiftHierarchyCommission = async ({ receiverId, sourceCoins, session = null }) => {
  if (!mongoose.Types.ObjectId.isValid(String(receiverId))) return null;

  const coins = Number(sourceCoins || 0);
  if (!Number.isFinite(coins) || coins <= 0) return null;

  const hostQuery = User.findById(receiverId)
    .select('hostStatus agencyId agencyCode hostRegistration.agencyCode hostRegistration.toplinerId hostRegistration.toplinerRole');
  if (session) hostQuery.session(session);
  const host = await hostQuery.lean();

  if (!host || host.hostStatus !== 'approved') return null;

  const month = getCommissionMonthKey();
  const day = getCommissionDayKey();
  const hostId = host._id;
  const toplinerId = host.hostRegistration?.toplinerId || null;
  const toplinerRole = String(host.hostRegistration?.toplinerRole || '').toLowerCase();
  const commission = {
    hostId,
    agencyId: null,
    adminId: null,
    managerId: null,
    hostShare: getCommissionAmount(coins, HOST_GIFT_SHARE_PERCENT),
    agencyCommission: 0,
    adminCommission: 0,
    managerCommission: 0,
    platformCommission: 0,
    agencyRatePercent: 0,
    adminRatePercent: ADMIN_COMMISSION_RATE_PERCENT,
    managerRatePercent: MANAGER_COMMISSION_RATE_PERCENT,
    commissionMonth: month,
    commissionDay: day,
  };
  let agencyTotalAfterGift = coins;

  if (toplinerId && mongoose.Types.ObjectId.isValid(String(toplinerId))) {
    if (toplinerRole === 'admin') {
      const admin = await findApprovedRoleUserForCommission({ userId: toplinerId, role: 'admin', session });
      if (admin) {
        commission.adminId = admin._id;
        const managerId = admin.adminAccessRequest?.toplinerId || null;
        const manager = await findApprovedRoleUserForCommission({ userId: managerId, role: 'manager', session });
        if (manager) commission.managerId = manager._id;
      }
    } else if (toplinerRole === 'manager') {
      const manager = await findApprovedRoleUserForCommission({ userId: toplinerId, role: 'manager', session });
      if (manager) commission.managerId = manager._id;
    } else if (toplinerRole === 'agency') {
      const agency = await findApprovedRoleUserForCommission({ userId: toplinerId, role: 'agency', session });
      if (agency) {
        commission.agencyId = agency._id;
        agencyTotalAfterGift = Number(agency.totalHostCoins || 0) + coins;
        const adminId = agency.agencyRegistration?.toplinerId || null;
        const admin = await findApprovedRoleUserForCommission({ userId: adminId, role: 'admin', session });
        if (admin) {
          commission.adminId = admin._id;
          const managerId = admin.adminAccessRequest?.toplinerId || null;
          const manager = await findApprovedRoleUserForCommission({ userId: managerId, role: 'manager', session });
          if (manager) commission.managerId = manager._id;
        }
      }
    }
  }

  if (!commission.agencyId) {
    const agency = await findApprovedAgencyForCommission({
      agencyId: host.agencyId,
      agencyCode: host.agencyCode || host.hostRegistration?.agencyCode || '',
      excludeUserId: hostId,
      session,
    });
    if (agency) {
      commission.agencyId = agency._id;
      agencyTotalAfterGift = Number(agency.totalHostCoins || 0) + coins;
      const adminId = agency.agencyRegistration?.toplinerId || null;
      const admin = await findApprovedRoleUserForCommission({ userId: adminId, role: 'admin', session });
      if (admin) {
        commission.adminId = admin._id;
        const managerId = admin.adminAccessRequest?.toplinerId || null;
        const manager = await findApprovedRoleUserForCommission({ userId: managerId, role: 'manager', session });
        if (manager) commission.managerId = manager._id;
      }
    }
  }

  commission.agencyRatePercent = commission.agencyId
    ? getAgencyCommissionTier(agencyTotalAfterGift).rate
    : 0;
  commission.agencyCommission = commission.agencyId
    ? getCommissionAmount(coins, commission.agencyRatePercent)
    : 0;
  commission.adminCommission = commission.adminId
    ? getCommissionAmount(coins, ADMIN_COMMISSION_RATE_PERCENT)
    : 0;
  commission.managerCommission = commission.managerId
    ? getCommissionAmount(coins, MANAGER_COMMISSION_RATE_PERCENT)
    : 0;
  commission.platformCommission = Math.max(
    0,
    coins - commission.hostShare - commission.agencyCommission - commission.adminCommission - commission.managerCommission
  );

  const ledgerUpdates = [
    commission.agencyId && updateCommissionLedger({
      beneficiaryId: commission.agencyId,
      beneficiaryRole: 'agency',
      hostId,
      sourceCoins: coins,
      commissionAmount: commission.agencyCommission,
      ratePercent: commission.agencyRatePercent,
      month,
      day,
      session,
    }),
    commission.adminId && updateCommissionLedger({
      beneficiaryId: commission.adminId,
      beneficiaryRole: 'admin',
      hostId,
      sourceCoins: coins,
      commissionAmount: commission.adminCommission,
      ratePercent: ADMIN_COMMISSION_RATE_PERCENT,
      month,
      day,
      session,
    }),
    commission.managerId && updateCommissionLedger({
      beneficiaryId: commission.managerId,
      beneficiaryRole: 'manager',
      hostId,
      sourceCoins: coins,
      commissionAmount: commission.managerCommission,
      ratePercent: MANAGER_COMMISSION_RATE_PERCENT,
      month,
      day,
      session,
    }),
    commission.agencyId && updateAgencyTargetProgress({
      agencyId: commission.agencyId,
      month,
      sourceCoins: coins,
      session,
    }),
    commission.agencyId && User.findByIdAndUpdate(
      commission.agencyId,
      { $inc: { totalHostCoins: coins } },
      { session }
    ),
  ].filter(Boolean);

  await Promise.all(ledgerUpdates);

  return commission;
};

const updateAgencyTargetProgress = async ({ agencyId, month, sourceCoins, session = null }) => {
  if (!agencyId || !month || !Number.isFinite(sourceCoins) || sourceCoins <= 0) return null;

  const target = await AgencyTarget.findOneAndUpdate(
    { agencyId, month },
    { $inc: { achievedCoins: sourceCoins } },
    { new: true, session }
  );

  if (
    target &&
    target.targetCoins > 0 &&
    target.achievedCoins >= target.targetCoins &&
    target.status !== 'achieved'
  ) {
    target.status = 'achieved';
    if (session) target.$session(session);
    await target.save();
  }

  return target;
};

const recordAgencyCommissionForGift = async ({ receiverId, sourceCoins }) => {
  if (!mongoose.Types.ObjectId.isValid(String(receiverId))) return null;

  const coins = Number(sourceCoins || 0);
  if (!Number.isFinite(coins) || coins <= 0) return null;

  const host = await User.findById(receiverId)
    .select('hostStatus agencyId agencyCode hostRegistration.agencyCode')
    .lean();

  if (!host || host.hostStatus !== 'approved') return null;

  let agencyId = host.agencyId || null;
  if (!agencyId) {
    const agencyCode = normalizeAgencyCode(host.agencyCode || host.hostRegistration?.agencyCode || '');
    const agency = await findApprovedAgencyByCode(agencyCode, host._id);
    agencyId = agency?._id || null;
    if (agencyId) {
      await User.findByIdAndUpdate(host._id, {
        $set: {
          agencyId,
          agencyCode: agency.agencyCode || agencyCode,
          'hostRegistration.agencyCode': agency.agencyCode || agencyCode,
        },
      });
    }
  }

  if (!agencyId) return null;

  const month = getCommissionMonthKey();
  const day = getCommissionDayKey();
  const agency = await User.findOne({
    _id: agencyId,
    $or: [{ role: 'agency' }, { roles: 'agency' }, { agencyStatus: 'approved' }],
  }).select('totalHostCoins').lean();

  if (!agency) return null;

  const agencyCoinsAfterGift = Number(agency.totalHostCoins || 0) + coins;
  const ratePercent = getAgencyCommissionTier(agencyCoinsAfterGift).rate;
  const commissionAmount = Math.floor((coins * ratePercent) / 100);

  await Promise.all([
    MonthlyCommission.findOneAndUpdate(
      {
        beneficiaryId: agencyId,
        beneficiaryRole: 'agency',
        hostId: receiverId,
        month,
      },
      {
        $inc: {
          sourceCoins: coins,
          commissionAmount,
        },
        $set: {
          ratePercent,
          status: 'pending',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ),
    DailyCommission.findOneAndUpdate(
      {
        beneficiaryId: agencyId,
        beneficiaryRole: 'agency',
        hostId: receiverId,
        day,
      },
      {
        $inc: {
          sourceCoins: coins,
          commissionAmount,
        },
        $set: {
          ratePercent,
          status: 'pending',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ),
    updateAgencyTargetProgress({ agencyId, month, sourceCoins: coins }),
    User.findByIdAndUpdate(agencyId, {
      $inc: {
        totalHostCoins: coins,
        commissionBalance: commissionAmount,
      },
    }),
  ]);

  return { agencyId, sourceCoins: coins, commissionAmount, ratePercent, month, day };
};

const sendDuplicateAgencyCodeResponse = (res) => (
  res.status(409).json({
    success: false,
    message: 'Agency code already exists. Please choose another code.',
  })
);

const isDuplicateAgencyCodeError = (error) => (
  error?.code === 11000 &&
  (error?.keyPattern?.agencyCode || error?.keyValue?.agencyCode)
);

app.post('/agency/register', async (req, res) => {
  try {
    const user = await getAuthenticatedAppUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Please login before agency registration.' });

    if ((user.accountStatus || 'active') !== 'active') {
      return res.status(403).json({ success: false, message: `Your account is ${user.accountStatus}.` });
    }

    if (user.agencyStatus === 'approved') {
      return res.status(400).json({ success: false, message: 'Your agency account is already approved.' });
    }

    const agencyName = String(req.body?.agencyName || '').trim();
    const ownerName = String(req.body?.ownerName || '').trim();
    const requestedAgencyCode = normalizeAgencyCode(req.body?.agencyCode || req.body?.requestedAgencyCode);
    const phoneCountryCode = String(req.body?.phoneCountryCode || '').trim();
    const phoneNumber = String(req.body?.phoneNumber || '').trim();
    const city = String(req.body?.city || '').trim();
    const expectedHosts = Math.max(0, Number(req.body?.expectedHosts) || 0);
    const experience = String(req.body?.experience || '').trim();
    const toplinerId = String(req.body?.toplinerId || '').trim();
    const toplinerRole = String(req.body?.toplinerRole || '').trim().toLowerCase();
    const acceptedTerms = req.body?.acceptedTerms === true;
    const verificationImages = req.body?.verificationImages || {};

    if (!agencyName) return res.status(400).json({ success: false, message: 'Agency name is required.' });
    if (!ownerName) return res.status(400).json({ success: false, message: 'Owner name is required.' });
    const agencyCodeError = validateAgencyCode(requestedAgencyCode);
    if (agencyCodeError) return res.status(400).json({ success: false, message: agencyCodeError });
    if (!phoneNumber) return res.status(400).json({ success: false, message: 'Phone number is required.' });
    if (!city) return res.status(400).json({ success: false, message: 'City is required.' });
    if (!acceptedTerms) return res.status(400).json({ success: false, message: 'Please accept agency terms.' });

    const requiredPhotos = ['profilePhoto', 'idFront', 'idBack', 'selfiePhoto'];
    const missingPhoto = requiredPhotos.find(key => !verificationImages?.[key]?.base64);
    if (missingPhoto) return res.status(400).json({ success: false, message: `${missingPhoto} photo is required.` });

    const topliner = await getToplinerSelection({
      toplinerId,
      toplinerRole,
      allowedRoles: TOPLINER_ROLE_OPTIONS.agency,
    });

    const existingAgencyCodeOwner = await findAgencyCodeOwner(requestedAgencyCode, user._id);
    if (existingAgencyCodeOwner) return sendDuplicateAgencyCodeResponse(res);

    const [profilePhotoUrl, idFrontUrl, idBackUrl, selfiePhotoUrl] = await Promise.all([
      uploadAgencyVerificationImage(user._id, verificationImages.profilePhoto, 'profile-photo'),
      uploadAgencyVerificationImage(user._id, verificationImages.idFront, 'id-front'),
      uploadAgencyVerificationImage(user._id, verificationImages.idBack, 'id-back'),
      uploadAgencyVerificationImage(user._id, verificationImages.selfiePhoto, 'selfie-photo'),
    ]);

    user.agencyStatus = 'pending';
    user.agencyRejectionReason = '';
    user.agencyRegistration = {
      agencyName,
      ownerName,
      requestedAgencyCode,
      toplinerId: topliner.id,
      toplinerRole: topliner.role,
      toplinerName: topliner.name,
      toplinerGlixId: topliner.glixId,
      phoneCountryCode,
      phoneNumber,
      city,
      expectedHosts,
      experience,
      profilePhotoUrl,
      idFrontUrl,
      idBackUrl,
      selfiePhotoUrl,
      status: 'pending',
      rejectionReason: '',
      reviewedBy: null,
      reviewedAt: null,
      acceptedTerms,
      registeredAt: new Date(),
    };

    await user.save();
    return res.status(201).json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    if (isDuplicateAgencyCodeError(error)) return sendDuplicateAgencyCodeResponse(res);
    console.log('Agency registration error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Unable to register agency profile.' });
  }
});


app.post('/host/register', async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.hostStatus === 'approved') return res.status(400).json({ success: false, message: 'Your host account is already approved.' });

    const fullName = String(req.body?.fullName || '').trim();
    const gender = ['Male', 'Female', 'Other'].includes(req.body?.gender) ? req.body.gender : '';
    const hostType = ['Video Live Host', 'Voice Live Host'].includes(req.body?.hostType) ? req.body.hostType : '';
    const agencySelection = ['Official', 'Other Agency'].includes(req.body?.agencySelection) ? req.body.agencySelection : '';
    const agencyCode = String(req.body?.agencyCode || '').trim().toUpperCase();
    const toplinerId = String(req.body?.toplinerId || '').trim();
    const toplinerRole = String(req.body?.toplinerRole || '').trim().toLowerCase();
    const phoneCountryCode = String(req.body?.phoneCountryCode || '').trim();
    const phoneNumber = String(req.body?.phoneNumber || '').trim();
    const acceptedTerms = req.body?.acceptedTerms === true;
    const verificationImages = req.body?.verificationImages || {};

    if (!fullName) return res.status(400).json({ success: false, message: 'Full name is required.' });
    if (!phoneNumber) return res.status(400).json({ success: false, message: 'Phone number is required.' });
    if (!acceptedTerms) return res.status(400).json({ success: false, message: 'Please accept host terms.' });
    if (!verificationImages?.selfiePhoto?.base64) return res.status(400).json({ success: false, message: 'Selfie verification photo is required.' });

    const topliner = await getToplinerSelection({
      toplinerId,
      toplinerRole,
      allowedRoles: TOPLINER_ROLE_OPTIONS.host,
    });
    const finalAgencySelection = 'Other Agency';
    const finalAgencyCode = normalizeAgencyCode(topliner.agencyCode || agencyCode);
    if (!finalAgencyCode) return res.status(400).json({ success: false, message: 'Selected agency does not have a valid agency code.' });

    const selfiePhotoUrl = await uploadUserImage(userId, verificationImages.selfiePhoto, 'host-selfie');

    user.hostStatus = 'pending';
    user.hostRejectionReason = '';
    user.hostRegistration = {
      fullName,
      gender,
      hostType,
      agencySelection: finalAgencySelection,
      agencyCode: finalAgencyCode,
      toplinerId: topliner.id,
      toplinerRole: topliner.role,
      toplinerName: topliner.name,
      toplinerGlixId: topliner.glixId,
      phoneCountryCode,
      phoneNumber,
      profilePhotoUrl: '',
      idFrontUrl: '',
      idBackUrl: '',
      selfiePhotoUrl,
      status: 'pending',
      rejectionReason: '',
      reviewedBy: null,
      reviewedAt: null,
      acceptedTerms,
      registeredAt: new Date(),
    };

    await user.save();
    return res.status(201).json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to register host profile.' });
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
      const agencyCode = normalizeAgencyCode(user.agencyRegistration?.requestedAgencyCode || user.agencyCode || `AG${String(user.glixId || user._id).slice(-5)}`);
      const agencyCodeError = validateAgencyCode(agencyCode);
      if (agencyCodeError) return res.status(400).json({ success: false, message: agencyCodeError });
      const existingAgencyCodeOwner = await findAgencyCodeOwner(agencyCode, user._id);
      if (existingAgencyCodeOwner) return sendDuplicateAgencyCodeResponse(res);
      addUserRole(user, 'agency');
      user.role = 'agency';
      user.agencyCode = agencyCode;
      user.agencyRegistration.requestedAgencyCode = agencyCode;
    } else {
      removeUserRole(user, 'agency');
    }
    await user.save();
    if (status === 'approved') await backfillApprovedHostsForAgency(user);
    return res.json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    if (isDuplicateAgencyCodeError(error)) return sendDuplicateAgencyCodeResponse(res);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/mobile/host/requests', requireAppRole('admin', 'manager', 'agency'), async (req, res) => {
  try {
    const authRoles = normalizeUserRoles(req.authUser);
    const isSuperAdmin = authRoles.includes('super_admin');
    const query = { hostStatus: 'pending' };

    if (!isSuperAdmin) {
      const assignedToMe = { 'hostRegistration.toplinerId': req.authUser._id };
      if (authRoles.includes('admin') || authRoles.includes('manager')) {
        query.$or = [
          assignedToMe,
          { 'hostRegistration.toplinerId': null },
          { 'hostRegistration.toplinerId': { $exists: false } },
        ];
      } else {
        query.$or = [assignedToMe];
      }
    }

    const requests = await User.find(query).select('-password -passwordResetOtpHash').sort({ 'hostRegistration.registeredAt': -1, createdAt: -1 }).lean();
    return res.json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/mobile/host/requests/:userId', requireAppRole('admin', 'manager', 'agency'), async (req, res) => {
  try {
    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, message: 'Invalid host status' });

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const authRoles = normalizeUserRoles(req.authUser);
    const assignedToplinerId = user.hostRegistration?.toplinerId;
    const isAssignedToRequester = assignedToplinerId && String(assignedToplinerId) === String(req.authUser._id);
    const isLegacyUnassigned = !assignedToplinerId && (authRoles.includes('admin') || authRoles.includes('manager') || authRoles.includes('super_admin'));
    if (!isAssignedToRequester && !isLegacyUnassigned && !authRoles.includes('super_admin')) {
      return res.status(403).json({ success: false, message: 'This host request is assigned to another topliner.' });
    }

    user.hostStatus = status;
    user.hostRejectionReason = status === 'rejected' ? String(req.body?.reason || '') : '';
    user.hostRegistration.status = status;
    user.hostRegistration.rejectionReason = user.hostRejectionReason;
    user.hostRegistration.reviewedBy = req.authUser._id;
    user.hostRegistration.reviewedAt = new Date();

    if (status === 'approved') {
      addUserRole(user, 'host');
      if (!user.role || user.role === 'user') user.role = 'host';
      await linkApprovedHostToAgency(user);
    } else {
      removeUserRole(user, 'host');
    }

    await user.save();
    return res.json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/mobile/admin-access/requests', requireAppRole('manager'), async (req, res) => {
  try {
    const authRoles = normalizeUserRoles(req.authUser);
    const query = {
      'adminAccessRequest.status': 'pending',
      'adminAccessRequest.requestedRole': authRoles.includes('super_admin') ? { $in: ['admin', 'manager'] } : 'admin',
    };

    if (!authRoles.includes('super_admin')) {
      query.$or = [
        { 'adminAccessRequest.toplinerId': req.authUser._id },
        { 'adminAccessRequest.toplinerId': null },
        { 'adminAccessRequest.toplinerId': { $exists: false } },
      ];
    }

    const requests = await User.find(query).select('-password -passwordResetOtpHash').sort({ 'adminAccessRequest.requestedAt': -1, createdAt: -1 }).lean();
    return res.json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/mobile/admin-access/requests/:userId', requireAppRole('manager'), async (req, res) => {
  try {
    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, message: 'Invalid request status' });

    const authRoles = normalizeUserRoles(req.authUser);
    const targetUser = await User.findById(req.params.userId).select('name email role roles adminAccessRequest');
    if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });
    const requestedRole = targetUser.adminAccessRequest?.requestedRole;
    if (!authRoles.includes('super_admin') && requestedRole !== 'admin') {
      return res.status(403).json({ success: false, message: 'Manager can only review admin access requests.' });
    }
    if (authRoles.includes('super_admin') && !['admin', 'manager'].includes(requestedRole)) {
      return res.status(403).json({ success: false, message: 'Invalid app access request role.' });
    }
    const assignedToplinerId = targetUser.adminAccessRequest?.toplinerId;
    if (assignedToplinerId && String(assignedToplinerId) !== String(req.authUser._id) && !authRoles.includes('super_admin')) {
      return res.status(403).json({ success: false, message: 'This admin request is assigned to another manager.' });
    }

    targetUser.adminAccessRequest.status = status;
    targetUser.adminAccessRequest.reviewedBy = req.authUser._id;
    targetUser.adminAccessRequest.reviewedAt = new Date();
    targetUser.adminAccessRequest.rejectionReason = status === 'rejected' ? String(req.body?.reason || '') : '';

    if (status === 'approved') {
      addUserRole(targetUser, requestedRole);
      if (!targetUser.role || targetUser.role === 'user') targetUser.role = requestedRole;
    } else {
      removeUserRole(targetUser, requestedRole);
    }

    await targetUser.save();
    return res.json({ success: true, user: serializeOfficialUser(targetUser) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/mobile/team/belows', requireAppRole('admin', 'manager', 'agency', 'coin_seller'), async (req, res) => {
  try {
    const authUser = req.authUser;
    const roles = normalizeUserRoles(authUser);
    const userProjection = 'name email profilePic glixId role roles hostStatus agencyStatus coinSellerStatus daimon chang totalHostCoins commissionBalance revenueBalance createdAt hostRegistration adminAccessRequest';
    const result = {
      admins: [],
      hosts: [],
      agencyHosts: [],
      buyers: [],
      counts: { admins: 0, hosts: 0, agencyHosts: 0, buyers: 0 },
    };

    if (roles.includes('manager')) {
      result.admins = await User.find({
        'adminAccessRequest.status': 'approved',
        'adminAccessRequest.requestedRole': 'admin',
        'adminAccessRequest.toplinerId': authUser._id,
      }).select(userProjection).sort({ 'adminAccessRequest.reviewedAt': -1, 'adminAccessRequest.requestedAt': -1, createdAt: -1 }).lean();
      result.hosts = await User.find({
        hostStatus: 'approved',
        'hostRegistration.toplinerId': authUser._id,
      }).select(userProjection).sort({ 'hostRegistration.reviewedAt': -1, 'hostRegistration.registeredAt': -1, createdAt: -1 }).lean();
    } else if (roles.includes('admin')) {
      result.hosts = await User.find({
        hostStatus: 'approved',
        'hostRegistration.toplinerId': authUser._id,
      }).select(userProjection).sort({ 'hostRegistration.reviewedAt': -1, 'hostRegistration.registeredAt': -1, createdAt: -1 }).lean();
    }

    if (roles.includes('agency')) {
      result.agencyHosts = await User.find(buildAgencyHostQuery(authUser))
        .select(userProjection)
        .sort({ createdAt: -1 })
        .lean();
    }

    if (roles.includes('coin_seller')) {
      const transactions = await CoinSellerTransaction.find({ sellerId: authUser._id })
        .populate('buyerId', 'name email profilePic glixId chang createdAt')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      const buyerMap = new Map();
      transactions.forEach((transaction) => {
        const buyer = transaction.buyerId || {};
        const buyerId = buyer._id?.toString?.() || transaction.buyerGlixId;
        if (!buyerId || buyerMap.has(buyerId)) return;
        buyerMap.set(buyerId, {
          ...buyer,
          lastCoins: transaction.coins || 0,
          lastSoldAt: transaction.createdAt,
        });
      });
      result.buyers = Array.from(buyerMap.values());
    }

    result.admins = result.admins.map(serializeOfficialUser);
    result.hosts = result.hosts.map(serializeOfficialUser);
    result.agencyHosts = result.agencyHosts.map(serializeOfficialUser);
    result.counts = {
      admins: result.admins.length,
      hosts: result.hosts.length,
      agencyHosts: result.agencyHosts.length,
      buyers: result.buyers.length,
    };

    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/mobile/agency/requests', requireAppRole('admin'), async (req, res) => {
  try {
    const authRoles = normalizeUserRoles(req.authUser);
    const query = { agencyStatus: 'pending' };
    if (!authRoles.includes('super_admin')) {
      query['agencyRegistration.toplinerId'] = req.authUser._id;
    }

    const requests = await User.find(query).select('-password -passwordResetOtpHash').sort({ 'agencyRegistration.registeredAt': -1, createdAt: -1 }).lean();
    return res.json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/mobile/agency/requests/:userId', requireAppRole('admin'), async (req, res) => {
  try {
    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, message: 'Invalid agency status' });

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const authRoles = normalizeUserRoles(req.authUser);
    const assignedToplinerId = user.agencyRegistration?.toplinerId;
    const isAssignedToRequester = assignedToplinerId && String(assignedToplinerId) === String(req.authUser._id);
    if (!isAssignedToRequester && !authRoles.includes('super_admin')) {
      return res.status(403).json({ success: false, message: 'This agency request is assigned to another admin.' });
    }

    user.agencyStatus = status;
    user.agencyRejectionReason = status === 'rejected' ? String(req.body?.reason || '') : '';
    user.agencyRegistration.status = status;
    user.agencyRegistration.rejectionReason = user.agencyRejectionReason;
    user.agencyRegistration.reviewedBy = req.authUser._id;
    user.agencyRegistration.reviewedAt = new Date();

    if (status === 'approved') {
      const agencyCode = normalizeAgencyCode(user.agencyRegistration?.requestedAgencyCode || user.agencyCode || `AG${String(user.glixId || user._id).slice(-5)}`);
      const agencyCodeError = validateAgencyCode(agencyCode);
      if (agencyCodeError) return res.status(400).json({ success: false, message: agencyCodeError });
      const existingAgencyCodeOwner = await findAgencyCodeOwner(agencyCode, user._id);
      if (existingAgencyCodeOwner) return sendDuplicateAgencyCodeResponse(res);
      addUserRole(user, 'agency');
      if (!user.role || user.role === 'user') user.role = 'agency';
      user.agencyCode = agencyCode;
      user.agencyRegistration.requestedAgencyCode = agencyCode;
    } else {
      removeUserRole(user, 'agency');
    }

    await user.save();
    if (status === 'approved') await backfillApprovedHostsForAgency(user);
    return res.json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    if (isDuplicateAgencyCodeError(error)) return sendDuplicateAgencyCodeResponse(res);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/mobile/admin/agencies', requireAppRole('admin'), async (req, res) => {
  try {
    const agencies = await User.aggregate([
      { $match: { $or: [{ role: 'agency' }, { roles: 'agency' }, { agencyStatus: 'approved' }] } },
      {
        $lookup: {
          from: 'users',
          let: { agencyUserId: '$_id', code: '$agencyCode' },
          pipeline: [
            {
              $match: {
                hostStatus: 'approved',
                $expr: {
                  $and: [
                    { $ne: ['$_id', '$$agencyUserId'] },
                    {
                      $or: [
                        { $eq: ['$agencyId', '$$agencyUserId'] },
                        {
                          $and: [
                            { $ne: ['$$code', ''] },
                            { $ne: ['$$code', 'OFFICIAL'] },
                            { $eq: ['$agencyCode', '$$code'] },
                          ],
                        },
                        {
                          $and: [
                            { $ne: ['$$code', ''] },
                            { $ne: ['$$code', 'OFFICIAL'] },
                            { $eq: ['$hostRegistration.agencyCode', '$$code'] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
          as: 'hosts',
        },
      },
      { $project: { name: 1, email: 1, glixId: 1, agencyCode: 1, totalHostCoins: 1, commissionBalance: 1, hostsCount: { $size: '$hosts' } } },
      { $sort: { createdAt: -1 } },
    ]);
    return res.json({ success: true, agencies });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/mobile/admin/agencies/:agencyId/hosts', requireAppRole('admin'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.agencyId)) return res.status(400).json({ success: false, message: 'Invalid agency id' });
    const agency = await User.findById(req.params.agencyId).select('_id agencyCode agencyRegistration agencyStatus').lean();
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });
    const hosts = await User.find(buildAgencyHostQuery(agency)).select('-password -passwordResetOtpHash').sort({ createdAt: -1 }).lean();
    return res.json({ success: true, hosts });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/mobile/admin/withdrawals', requireAppRole('admin', 'manager'), async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const query = status === 'all' ? {} : { status };
    const withdrawals = await Withdrawal.find(query).populate('userId', 'name email glixId').sort({ createdAt: -1 }).lean();
    return res.json({ success: true, withdrawals });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/access/requests', requireOfficial, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const appQuery = status === 'all' ? { 'adminAccessRequest.status': { $ne: 'none' } } : { 'adminAccessRequest.status': status };
    const officialStatus = status === 'approved' ? 'active' : status;
    const officialQuery = status === 'all' ? { status: { $in: ['pending', 'rejected'] } } : { status: officialStatus };

    const [appRequests, officialRequests] = await Promise.all([
      User.find(appQuery).select('-password -passwordResetOtpHash').sort({ 'adminAccessRequest.requestedAt': -1 }).lean(),
      OfficialUser.find(officialQuery).select(officialAccountProjection).sort({ createdAt: -1 }).lean(),
    ]);

    const officialRows = officialRequests.map(account => ({
      ...account,
      requestKind: 'official',
      adminAccessRequest: {
        requestedRole: account.role,
        status: account.status === 'active' ? 'approved' : account.status,
        note: account.note || '',
        rejectionReason: account.rejectionReason || '',
        reviewedBy: account.reviewedBy || null,
        reviewedAt: account.reviewedAt || null,
        requestedAt: account.createdAt,
      },
    }));
    const appRows = appRequests.map(user => {
      const request = user.adminAccessRequest || {};
      return {
        ...user,
        requestKind: 'app_user',
        adminAccessRequest: {
          requestedRole: request.requestedRole || '',
          status: request.status || 'none',
          note: request.note || '',
          rejectionReason: request.rejectionReason || '',
          reviewedBy: request.reviewedBy || null,
          reviewedAt: request.reviewedAt || null,
          requestedAt: request.requestedAt || user.updatedAt || user.createdAt,
        },
      };
    });
    const requests = [...officialRows, ...appRows].sort((a, b) => (
      new Date(b.adminAccessRequest?.requestedAt || b.createdAt || 0) - new Date(a.adminAccessRequest?.requestedAt || a.createdAt || 0)
    ));

    return res.json({
      success: true,
      requests,
      counts: {
        total: requests.length,
        appUsers: appRows.length,
        officialAccounts: officialRows.length,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/access/requests/:userId', requireOfficial, async (req, res) => {
  try {
    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, message: 'Invalid request status' });

    const requestKind = String(req.body?.requestKind || '').trim();
    if (requestKind === 'official') {
      const officialUser = await OfficialUser.findById(req.params.userId);
      if (!officialUser) return res.status(404).json({ success: false, message: 'Official account request not found' });
      if (String(officialUser._id) === String(req.officialUser._id) && status === 'rejected') {
        return res.status(400).json({ success: false, message: 'You cannot reject your own official account' });
      }
      officialUser.status = status === 'approved' ? 'active' : 'rejected';
      officialUser.role = ['admin', 'manager', 'super_admin'].includes(req.body?.role) ? req.body.role : officialUser.role;
      officialUser.rejectionReason = status === 'rejected' ? String(req.body?.reason || '') : '';
      officialUser.reviewedBy = req.officialUser._id;
      officialUser.reviewedAt = new Date();
      await officialUser.save();
      return res.json({ success: true, user: serializeOfficialAccount(officialUser) });
    }

    const targetUser = await User.findById(req.params.userId).select('name email password role roles adminAccessRequest');
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
    const write = { $set: update };
    if (status === 'approved') {
      if (!targetUser.role || targetUser.role === 'user') update.role = requestedRole;
      write.$addToSet = { roles: requestedRole };
    } else if (['admin', 'manager'].includes(requestedRole)) {
      write.$pull = { roles: requestedRole };
    }
    const user = await User.findByIdAndUpdate(req.params.userId, write, { new: true, runValidators: true });

    let tempPassword = '';
    if (status === 'approved') {
      tempPassword = '';
    }

    return res.json({ success: true, user: serializeOfficialUser(user), tempPassword });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, message: 'Official email already exists' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/official-users', requireOfficial, async (req, res) => {
  try {
    const accounts = await OfficialUser.find({}).select(officialAccountProjection).sort({ role: -1, createdAt: -1 }).lean();
    return res.json({ success: true, accounts: accounts.map(serializeOfficialAccount) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/official-users', requireOfficial, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = ['admin', 'manager', 'super_admin'].includes(req.body?.role) ? req.body.role : 'manager';
    const status = ['active', 'pending', 'blocked'].includes(req.body?.status) ? req.body.status : 'active';
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions.map(item => String(item).trim()).filter(Boolean) : [];

    if (!name || !email || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Name, email and a 6 character password are required' });
    }

    const account = await OfficialUser.create({
      name,
      email,
      password: await bcrypt.hash(password, 10),
      role,
      status,
      permissions,
      createdBy: req.officialUser._id,
      reviewedBy: req.officialUser._id,
      reviewedAt: new Date(),
    });
    return res.status(201).json({ success: true, account: serializeOfficialAccount(account) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, message: 'Official email already exists' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/official-users/:officialUserId', requireOfficial, async (req, res) => {
  try {
    const account = await OfficialUser.findById(req.params.officialUserId);
    if (!account) return res.status(404).json({ success: false, message: 'Official account not found' });

    const isSelf = String(account._id) === String(req.officialUser._id);
    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) account.name = String(req.body.name || '').trim() || account.name;
    if (Object.prototype.hasOwnProperty.call(req.body, 'email')) account.email = String(req.body.email || '').trim().toLowerCase() || account.email;
    if (['admin', 'manager', 'super_admin'].includes(req.body?.role)) {
      if (isSelf && req.body.role !== 'super_admin') return res.status(400).json({ success: false, message: 'You cannot remove your own Super Admin role' });
      account.role = req.body.role;
    }
    if (['active', 'pending', 'blocked', 'rejected'].includes(req.body?.status)) {
      if (isSelf && req.body.status !== 'active') return res.status(400).json({ success: false, message: 'You cannot disable your own official account' });
      account.status = req.body.status;
    }
    if (Array.isArray(req.body?.permissions)) account.permissions = req.body.permissions.map(item => String(item).trim()).filter(Boolean);
    if (String(req.body?.password || '').length >= 6) account.password = await bcrypt.hash(String(req.body.password), 10);
    if (Object.prototype.hasOwnProperty.call(req.body, 'rejectionReason')) account.rejectionReason = String(req.body.rejectionReason || '').trim();
    account.reviewedBy = req.officialUser._id;
    account.reviewedAt = new Date();
    await account.save();

    return res.json({ success: true, account: serializeOfficialAccount(account) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, message: 'Official email already exists' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

const WITHDRAWAL_DIAMOND_TO_PKR = Number(process.env.WITHDRAWAL_DIAMOND_TO_PKR || 0.027);
const WITHDRAWAL_DIAMOND_TO_USD = Number(process.env.WITHDRAWAL_DIAMOND_TO_USD || (7 / 170000));
const WITHDRAWAL_MIN_DIAMONDS = Math.floor(Number(process.env.WITHDRAWAL_MIN_DIAMONDS || 10000));
const DIAMOND_EXCHANGE_RATE = Number(process.env.DIAMOND_EXCHANGE_RATE || 1);
const DIAMOND_EXCHANGE_MARGIN_PERCENT = Math.min(100, Math.max(0, Number(process.env.DIAMOND_EXCHANGE_MARGIN_PERCENT || 10)));
const DIAMOND_EXCHANGE_MIN_DIAMONDS = Math.floor(Number(process.env.DIAMOND_EXCHANGE_MIN_DIAMONDS || 1000));
const HOST_WITHDRAWAL_POLICY = [
  170000,
  340000,
  680000,
  1360000,
  2720000,
  5440000,
  10880000,
  21760000,
  43520000,
  87040000,
].map((coins) => ({
  senderSends: coins,
  hostReceives: coins,
  usd: Number((coins * WITHDRAWAL_DIAMOND_TO_USD).toFixed(2)),
}));
const WITHDRAWAL_METHODS = [
  { id: 'paypal', method: 'PayPal', country: 'All Countries', countryCode: 'global', title: 'PayPal', subtitle: 'Transfer to PayPal account', icon: 'card', feePercent: 5, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'USD', exchangeRate: WITHDRAWAL_DIAMOND_TO_USD, fields: { accountNumber: 'PayPal Email', firstName: 'First name', lastName: 'Last name' } },
  { id: 'usdt', method: 'USDT', country: 'All Countries', countryCode: 'global', title: 'USDT', subtitle: 'Cryptocurrency transfer', icon: 'crypto', feePercent: 1.5, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'USDT', exchangeRate: WITHDRAWAL_DIAMOND_TO_USD, fields: { accountNumber: 'USDT Wallet Address', firstName: 'First name', lastName: 'Last name' } },
  { id: 'binance', method: 'Binance', country: 'All Countries', countryCode: 'global', title: 'Binance', subtitle: 'Crypto transfer via Binance', icon: 'crypto', feePercent: 1.5, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'USDT', exchangeRate: WITHDRAWAL_DIAMOND_TO_USD, fields: { accountNumber: 'Binance ID / Email', network: 'Network, e.g. TRC20 / BEP20', walletAddress: 'Wallet Address', firstName: 'First name', lastName: 'Last name' } },
  { id: 'epay', method: 'EPAY Wallet', country: 'All Countries', countryCode: 'global', title: 'EPAY Wallet', subtitle: 'European bank transfer', icon: 'wallet', feePercent: 0, feeFixedDiamonds: 10000, arrivalText: '6 hours', payoutCurrency: 'EUR', exchangeRate: Number(process.env.WITHDRAWAL_DIAMOND_TO_EUR || 0.000092), fields: { accountNumber: 'EPAY Wallet Account', firstName: 'First name', lastName: 'Last name' } },
  { id: 'jazzcash', method: 'JazzCash', country: 'Pakistan', countryCode: 'PK', title: 'JazzCash', subtitle: 'Transfer to JazzCash account', icon: 'wallet', feePercent: 1.7, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'PKR', exchangeRate: WITHDRAWAL_DIAMOND_TO_PKR, fields: { accountNumber: 'JazzCash Number', firstName: 'First name', lastName: 'Last name' } },
  { id: 'easypaisa', method: 'EasyPaisa', country: 'Pakistan', countryCode: 'PK', title: 'EasyPaisa', subtitle: 'Bank account transfer', icon: 'bank', feePercent: 1.7, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'PKR', exchangeRate: WITHDRAWAL_DIAMOND_TO_PKR, fields: { accountNumber: 'EasyPaisa Number', firstName: 'First name', lastName: 'Last name' } },
  { id: 'bank_pk', method: 'Bank Transfer', country: 'Pakistan', countryCode: 'PK', title: 'Bank Transfer', subtitle: 'Bank account transfer', icon: 'bank', feePercent: 1.7, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'PKR', exchangeRate: WITHDRAWAL_DIAMOND_TO_PKR, fields: { accountNumber: 'Bank Account / IBAN', firstName: 'First name', lastName: 'Last name' } },
  { id: 'bkash', method: 'bKash', country: 'Bangladesh', countryCode: 'BD', title: 'bKash', subtitle: 'Transfer to bKash account', icon: 'wallet', feePercent: 1.7, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'BDT', exchangeRate: Number(process.env.WITHDRAWAL_DIAMOND_TO_BDT || 0.012), fields: { accountNumber: 'bKash Number', firstName: 'First name', lastName: 'Last name' } },
  { id: 'nagad', method: 'Nagad', country: 'Bangladesh', countryCode: 'BD', title: 'Nagad', subtitle: 'Bank account transfer', icon: 'bank', feePercent: 1.7, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'BDT', exchangeRate: Number(process.env.WITHDRAWAL_DIAMOND_TO_BDT || 0.012), fields: { accountNumber: 'Nagad Number', firstName: 'First name', lastName: 'Last name' } },
  { id: 'bank_bd', method: 'Bangladesh Bank Transfer', country: 'Bangladesh', countryCode: 'BD', title: 'Bank Transfer', subtitle: 'Bank account transfer', icon: 'bank', feePercent: 1.7, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'BDT', exchangeRate: Number(process.env.WITHDRAWAL_DIAMOND_TO_BDT || 0.012), fields: { accountNumber: 'Bank Account', firstName: 'First name', lastName: 'Last name' } },
  { id: 'pix', method: 'PIX', country: 'Brazil', countryCode: 'BR', title: 'PIX', subtitle: 'Instant transfer via PIX', icon: 'wallet', feePercent: 1.7, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'BRL', exchangeRate: Number(process.env.WITHDRAWAL_DIAMOND_TO_BRL || 0.00055), fields: { accountNumber: 'PIX Key', firstName: 'First name', lastName: 'Last name' } },
  { id: 'telebirr', method: 'telebirr', country: 'Ethiopia', countryCode: 'ET', title: 'telebirr', subtitle: 'Bank account transfer', icon: 'bank', feePercent: 1.7, feeFixedDiamonds: 0, arrivalText: '6 hours', payoutCurrency: 'ETB', exchangeRate: Number(process.env.WITHDRAWAL_DIAMOND_TO_ETB || 0.006), fields: { accountNumber: 'telebirr Number', firstName: 'First name', lastName: 'Last name' } },
];

const getWithdrawalMethodConfig = (method = '', country = '') => {
  const cleanMethod = String(method || '').trim().toLowerCase();
  const cleanCountry = String(country || '').trim().toLowerCase();
  return WITHDRAWAL_METHODS.find(item => (
    item.id.toLowerCase() === cleanMethod ||
    (item.method.toLowerCase() === cleanMethod && (!cleanCountry || item.country.toLowerCase() === cleanCountry || item.countryCode.toLowerCase() === cleanCountry)) ||
    (item.title.toLowerCase() === cleanMethod && (!cleanCountry || item.country.toLowerCase() === cleanCountry || item.countryCode.toLowerCase() === cleanCountry))
  ));
};

const serializeWithdrawalConfig = () => ({
  success: true,
  minimumDiamonds: WITHDRAWAL_MIN_DIAMONDS,
  defaultExchangeRate: WITHDRAWAL_DIAMOND_TO_PKR,
  usdExchangeRate: WITHDRAWAL_DIAMOND_TO_USD,
  hostReceivingPolicy: HOST_WITHDRAWAL_POLICY,
  diamondExchange: {
    rate: DIAMOND_EXCHANGE_RATE,
    marginPercent: DIAMOND_EXCHANGE_MARGIN_PERCENT,
    minimumDiamonds: DIAMOND_EXCHANGE_MIN_DIAMONDS,
  },
  methods: WITHDRAWAL_METHODS,
  rules: [
    'Withdrawals are subject to verification to ensure platform security.',
    'Coins purchased by yourself cannot be withdrawn.',
    'Withdrawal methods are different. Please choose the appropriate one.',
  ],
});

app.get('/withdrawals/config', async (req, res) => {
  return res.json(serializeWithdrawalConfig());
});

app.post('/wallet/exchange', async (req, res) => {
  try {
    const authUser = await getAuthenticatedAppUser(req);
    const userId = String(req.body?.userId || authUser?._id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (authUser && String(authUser._id) !== String(userId)) return res.status(403).json({ success: false, message: 'Cannot exchange diamonds for another user' });

    const diamonds = Math.floor(Number(req.body?.amount || req.body?.diamonds));
    if (!Number.isFinite(diamonds) || diamonds < DIAMOND_EXCHANGE_MIN_DIAMONDS) {
      return res.status(400).json({ success: false, message: `Minimum exchange is ${DIAMOND_EXCHANGE_MIN_DIAMONDS} diamonds` });
    }

    const grossCoins = Math.floor(diamonds * DIAMOND_EXCHANGE_RATE);
    const marginCoins = Math.floor((grossCoins * DIAMOND_EXCHANGE_MARGIN_PERCENT) / 100);
    const netCoins = Math.max(0, grossCoins - marginCoins);
    if (netCoins <= 0) return res.status(400).json({ success: false, message: 'Exchange amount is too small after margin.' });

    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, daimon: { $gte: diamonds } },
      { $inc: { daimon: -diamonds, chang: netCoins } },
      { new: true }
    ).select('daimon chang commissionBalance revenueBalance');

    if (!updatedUser) {
      return res.status(400).json({ success: false, message: 'Insufficient diamonds.' });
    }

    const exchange = await DiamondExchange.create({
      userId,
      diamonds,
      grossCoins,
      marginPercent: DIAMOND_EXCHANGE_MARGIN_PERCENT,
      marginCoins,
      netCoins,
      rate: DIAMOND_EXCHANGE_RATE,
    });

    return res.status(201).json({
      success: true,
      exchange,
      wallet: {
        daimon: updatedUser.daimon || 0,
        chang: updatedUser.chang || 0,
        commissionBalance: updatedUser.commissionBalance || 0,
        revenueBalance: updatedUser.revenueBalance || 0,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/wallet/exchanges/my/:userId', async (req, res) => {
  try {
    const authUser = await getAuthenticatedAppUser(req);
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (authUser && String(authUser._id) !== String(userId)) return res.status(403).json({ success: false, message: 'Cannot view exchanges for another user' });

    const exchanges = await DiamondExchange.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({ success: true, exchanges });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

const getWithdrawalSourceForUser = (user, requestedSource = '') => {
  const source = String(requestedSource || '').trim();
  if (['daimon', 'commissionBalance', 'revenueBalance'].includes(source)) return source;
  if (hasUserRole(user, 'agency') || user?.agencyStatus === 'approved') return 'commissionBalance';
  if (hasUserRole(user, 'manager')) return 'commissionBalance';
  if (['admin', 'super_admin'].some(role => hasUserRole(user, role))) return 'revenueBalance';
  return 'daimon';
};

app.post('/withdrawals', async (req, res) => {
  try {
    const authUser = await getAuthenticatedAppUser(req);
    const userId = String(req.body?.userId || authUser?._id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (authUser && String(authUser._id) !== String(userId)) return res.status(403).json({ success: false, message: 'Cannot submit withdrawal for another user' });

    const amount = Math.floor(Number(req.body?.amount));
    const method = String(req.body?.method || '').trim();
    const country = String(req.body?.country || '').trim();
    const accountTitle = String(req.body?.accountTitle || '').trim();
    const accountNumber = String(req.body?.accountNumber || '').trim();
    const note = String(req.body?.note || '').trim();
    const firstName = String(req.body?.firstName || '').trim();
    const lastName = String(req.body?.lastName || '').trim();
    const details = req.body?.details && typeof req.body.details === 'object' && !Array.isArray(req.body.details)
      ? Object.fromEntries(Object.entries(req.body.details).map(([key, value]) => [key, String(value || '').trim()]))
      : {};

    const methodConfig = getWithdrawalMethodConfig(method, country);
    if (!Number.isFinite(amount) || amount < WITHDRAWAL_MIN_DIAMONDS) {
      return res.status(400).json({ success: false, message: `Minimum withdrawal is ${WITHDRAWAL_MIN_DIAMONDS} diamonds` });
    }
    if (!methodConfig) return res.status(400).json({ success: false, message: 'Invalid withdrawal method' });
    if (!accountTitle || !accountNumber) return res.status(400).json({ success: false, message: 'Account title and account number are required' });
    const missingDetailField = Object.entries(methodConfig.fields || {}).find(([key]) => (
      !['accountNumber', 'firstName', 'lastName'].includes(key) && !details[key]
    ));
    if (missingDetailField) {
      return res.status(400).json({ success: false, message: `${missingDetailField[1]} is required` });
    }

    const feeAmount = Math.ceil((amount * Number(methodConfig.feePercent || 0)) / 100) + Math.floor(Number(methodConfig.feeFixedDiamonds || 0));
    const netDiamonds = Math.max(0, amount - feeAmount);
    const payoutAmount = Number((netDiamonds * Number(methodConfig.exchangeRate || 0)).toFixed(2));
    const proofImageUrl = req.body?.proofImage?.base64
      ? await uploadUserImage(userId, req.body.proofImage, 'withdrawal-proof')
      : '';

    const user = await User.findById(userId).select('role agencyStatus daimon commissionBalance revenueBalance');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const source = getWithdrawalSourceForUser(user, req.body?.source);
    if (Number(user[source] || 0) < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient withdrawable balance' });
    }

    const withdrawal = await Withdrawal.create({
      userId,
      amount,
      source,
      method: methodConfig.method,
      country: methodConfig.country,
      accountTitle,
      accountNumber,
      details,
      note: note || [firstName, lastName].filter(Boolean).join(' '),
      payoutCurrency: methodConfig.payoutCurrency,
      exchangeRate: methodConfig.exchangeRate,
      feePercent: methodConfig.feePercent,
      feeAmount,
      payoutAmount,
      arrivalText: methodConfig.arrivalText,
      proofImageUrl,
      status: 'pending',
      balanceDeducted: false,
    });

    return res.status(201).json({
      success: true,
      withdrawal,
      wallet: {
        daimon: user.daimon || 0,
        commissionBalance: user.commissionBalance || 0,
        revenueBalance: user.revenueBalance || 0,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/withdrawals/my/:userId', async (req, res) => {
  try {
    const authUser = await getAuthenticatedAppUser(req);
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (authUser && String(authUser._id) !== String(userId)) return res.status(403).json({ success: false, message: 'Cannot view withdrawals for another user' });

    const withdrawals = await Withdrawal.find({ userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({ success: true, withdrawals });
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

    const existingWithdrawal = await Withdrawal.findById(req.params.withdrawalId);
    if (!existingWithdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    if (existingWithdrawal.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'This withdrawal has already been reviewed' });
    }

    existingWithdrawal.status = status;
    existingWithdrawal.reviewerId = req.officialUser._id;
    existingWithdrawal.reviewNote = String(req.body?.reviewNote || req.body?.reason || '');
    existingWithdrawal.transactionRef = String(req.body?.transactionRef || '');
    existingWithdrawal.reviewedAt = new Date();

    let updatedWalletUser = null;
    const wasBalanceDeducted = existingWithdrawal.balanceDeducted === true;
    if (status === 'approved' && !wasBalanceDeducted) {
      updatedWalletUser = await User.findOneAndUpdate(
        {
          _id: existingWithdrawal.userId,
          [existingWithdrawal.source]: { $gte: existingWithdrawal.amount },
        },
        {
          $inc: { [existingWithdrawal.source]: -existingWithdrawal.amount },
        },
        { new: true }
      ).select('daimon commissionBalance revenueBalance');

      if (!updatedWalletUser) {
        return res.status(400).json({ success: false, message: 'Insufficient withdrawable balance for approval.' });
      }

      existingWithdrawal.balanceDeducted = true;
      existingWithdrawal.deductedAt = new Date();
    }

    await existingWithdrawal.save();

    if (status === 'rejected') {
      if (existingWithdrawal.balanceDeducted === true) {
        updatedWalletUser = await User.findByIdAndUpdate(existingWithdrawal.userId, {
          $inc: { [existingWithdrawal.source]: existingWithdrawal.amount }
        }, { new: true }).select('daimon commissionBalance revenueBalance');
        existingWithdrawal.balanceDeducted = false;
        await existingWithdrawal.save();
      } else {
        updatedWalletUser = await User.findById(existingWithdrawal.userId).select('daimon commissionBalance revenueBalance');
      }
    }

    const withdrawal = await Withdrawal.findById(existingWithdrawal._id).populate('userId', 'name email glixId');
    if (!updatedWalletUser) {
      updatedWalletUser = await User.findById(existingWithdrawal.userId).select('daimon commissionBalance revenueBalance');
    }

    return res.json({
      success: true,
      withdrawal,
      wallet: {
        daimon: updatedWalletUser?.daimon || 0,
        commissionBalance: updatedWalletUser?.commissionBalance || 0,
        revenueBalance: updatedWalletUser?.revenueBalance || 0,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/withdrawals/:withdrawalId/deduct-balance', requireOfficial, async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.withdrawalId);
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    if (withdrawal.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Only approved withdrawals can be repaired.' });
    }
    if (withdrawal.balanceDeducted === true) {
      const walletUser = await User.findById(withdrawal.userId).select('daimon commissionBalance revenueBalance');
      return res.json({
        success: true,
        message: 'Withdrawal balance was already deducted.',
        withdrawal,
        wallet: {
          daimon: walletUser?.daimon || 0,
          commissionBalance: walletUser?.commissionBalance || 0,
          revenueBalance: walletUser?.revenueBalance || 0,
        },
      });
    }

    const updatedWalletUser = await User.findOneAndUpdate(
      {
        _id: withdrawal.userId,
        [withdrawal.source]: { $gte: withdrawal.amount },
      },
      {
        $inc: { [withdrawal.source]: -withdrawal.amount },
      },
      { new: true }
    ).select('daimon commissionBalance revenueBalance');

    if (!updatedWalletUser) {
      return res.status(400).json({ success: false, message: 'Insufficient withdrawable balance to repair this approved withdrawal.' });
    }

    withdrawal.balanceDeducted = true;
    withdrawal.deductedAt = new Date();
    withdrawal.reviewNote = [withdrawal.reviewNote, 'Balance deducted by official repair.'].filter(Boolean).join(' ');
    await withdrawal.save();

    return res.json({
      success: true,
      message: 'Withdrawal balance deducted.',
      withdrawal,
      wallet: {
        daimon: updatedWalletUser.daimon || 0,
        commissionBalance: updatedWalletUser.commissionBalance || 0,
        revenueBalance: updatedWalletUser.revenueBalance || 0,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/agencies', requireOfficial, async (req, res) => {
  try {
    const agencies = await User.aggregate([
      { $match: { $or: [{ role: 'agency' }, { roles: 'agency' }, { agencyStatus: 'approved' }] } },
      {
        $lookup: {
          from: 'users',
          let: { agencyUserId: '$_id', code: '$agencyCode' },
          pipeline: [
            {
              $match: {
                hostStatus: 'approved',
                $expr: {
                  $and: [
                    { $ne: ['$_id', '$$agencyUserId'] },
                    {
                      $or: [
                        { $eq: ['$agencyId', '$$agencyUserId'] },
                        {
                          $and: [
                            { $ne: ['$$code', ''] },
                            { $ne: ['$$code', 'OFFICIAL'] },
                            { $eq: ['$agencyCode', '$$code'] },
                          ],
                        },
                        {
                          $and: [
                            { $ne: ['$$code', ''] },
                            { $ne: ['$$code', 'OFFICIAL'] },
                            { $eq: ['$hostRegistration.agencyCode', '$$code'] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
          as: 'hosts',
        },
      },
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
    const agencyCode = normalizeAgencyCode(req.body?.agencyCode || agency.agencyCode || `AG${String(agency.glixId || agency._id).slice(-5)}`);
    const agencyCodeError = validateAgencyCode(agencyCode);
    if (agencyCodeError) return res.status(400).json({ success: false, message: agencyCodeError });
    const existingAgencyCodeOwner = await findAgencyCodeOwner(agencyCode, agency._id);
    if (existingAgencyCodeOwner) return sendDuplicateAgencyCodeResponse(res);
    agency.role = 'agency';
    agency.agencyStatus = 'approved';
    agency.agencyCode = agencyCode;
    agency.agencyRegistration.requestedAgencyCode = agencyCode;
    agency.agencyRegistration.status = 'approved';
    agency.agencyRegistration.reviewedBy = req.officialUser._id;
    agency.agencyRegistration.reviewedAt = new Date();
    await agency.save();
    await backfillApprovedHostsForAgency(agency);
    return res.json({ success: true, agency: serializeOfficialUser(agency) });
  } catch (error) {
    if (isDuplicateAgencyCodeError(error)) return sendDuplicateAgencyCodeResponse(res);
    return res.status(500).json({ success: false, message: error.message });
  }
});


app.patch('/admin/agencies/:agencyId', requireOfficial, async (req, res) => {
  try {
    const agencyCode = normalizeAgencyCode(req.body?.agencyCode);
    if (!mongoose.Types.ObjectId.isValid(req.params.agencyId)) return res.status(400).json({ success: false, message: 'Invalid agency id' });
    const agencyCodeError = validateAgencyCode(agencyCode);
    if (agencyCodeError) return res.status(400).json({ success: false, message: agencyCodeError });
    const existingAgencyCodeOwner = await findAgencyCodeOwner(agencyCode, req.params.agencyId);
    if (existingAgencyCodeOwner) return sendDuplicateAgencyCodeResponse(res);

    const agency = await User.findByIdAndUpdate(req.params.agencyId, { $set: { agencyCode, 'agencyRegistration.requestedAgencyCode': agencyCode } }, { new: true, runValidators: true });
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });
    await backfillApprovedHostsForAgency(agency);
    return res.json({ success: true, agency: serializeOfficialUser(agency) });
  } catch (error) {
    if (isDuplicateAgencyCodeError(error)) return sendDuplicateAgencyCodeResponse(res);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/agencies/:agencyId/hosts', requireOfficial, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.agencyId)) return res.status(400).json({ success: false, message: 'Invalid agency id' });
    const agency = await User.findById(req.params.agencyId).select('_id agencyCode agencyRegistration agencyStatus').lean();
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });
    const hosts = await User.find(buildAgencyHostQuery(agency)).select('-password -passwordResetOtpHash').sort({ createdAt: -1 }).lean();
    return res.json({ success: true, hosts });
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


const sellerProjection = 'name email profilePic glixId role roles accountStatus coinSellerStatus coinSellerRegistration sellerBalance sellerTotalSold createdAt';

const serializeSeller = (user) => {
  if (!user) return null;
  const plain = typeof user.toObject === 'function' ? user.toObject() : user;
  const { password, passwordResetOtpHash, adminAccessRequest, ...safe } = plain;
  safe.roles = normalizeUserRoles(safe);
  return safe;
};

app.get('/coin-sellers/public', async (req, res) => {
  try {
    const sellers = await User.find({
      accountStatus: { $ne: 'blocked' },
      coinSellerStatus: { $ne: 'suspended' },
      $or: [
        { coinSellerStatus: 'approved' },
        { 'coinSellerRegistration.status': 'approved' },
      ],
    })
      .select('name profilePic glixId countryRegion coinSellerStatus coinSellerRegistration')
      .sort({ 'coinSellerRegistration.reviewedAt': -1, name: 1 })
      .lean();

    const publicSellers = sellers.map((seller) => ({
      id: seller._id?.toString?.() || String(seller._id),
      name: seller.coinSellerRegistration?.fullName || seller.name || 'Coin Seller',
      profilePic: seller.profilePic || '',
      glixId: seller.glixId || '',
      country: seller.countryRegion || '',
      city: seller.coinSellerRegistration?.city || '',
      phoneNumber: seller.coinSellerRegistration?.phoneNumber || '',
      paymentMethod: seller.coinSellerRegistration?.paymentMethod || '',
    }));

    return res.json({ success: true, sellers: publicSellers });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});
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
    if (seller.coinSellerStatus !== 'approved' && !hasUserRole(seller, 'coin_seller')) {
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
    if (user.coinSellerStatus !== 'approved' && !hasUserRole(user, 'coin_seller')) {
      return res.status(403).json({ success: false, message: `Coin seller request is ${user.coinSellerStatus || 'not approved'}` });
    }

    user.lastLogin = new Date();
    if (!user.role || user.role === 'user') user.role = 'coin_seller';
    addUserRole(user, 'coin_seller');
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
      coinSellerStatus: status,
      coinSellerRejectionReason: status === 'rejected' ? String(req.body?.reason || '') : '',
      'coinSellerRegistration.status': status,
      'coinSellerRegistration.rejectionReason': status === 'rejected' ? String(req.body?.reason || '') : '',
      'coinSellerRegistration.reviewedBy': req.officialUser._id,
      'coinSellerRegistration.reviewedAt': new Date(),
    };
    if (status === 'approved') update.role = 'coin_seller';
    Object.keys(update).forEach(key => update[key] === undefined && delete update[key]);
    const write = { $set: update };
    if (status === 'approved') write.$addToSet = { roles: 'coin_seller' };
    if (['rejected', 'suspended'].includes(status)) write.$pull = { roles: 'coin_seller' };
    const user = await User.findByIdAndUpdate(req.params.userId, write, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: serializeOfficialUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/coin-sellers', requireOfficial, async (req, res) => {
  try {
    const sellers = await User.find({ $or: [{ coinSellerStatus: { $in: ['approved', 'suspended'] } }, { role: 'coin_seller' }, { roles: 'coin_seller' }] })
      .select('name email glixId role roles coinSellerStatus coinSellerRegistration sellerBalance sellerTotalSold createdAt')
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

app.get('/admin/daily-commissions', requireOfficial, async (req, res) => {
  try {
    const query = {};
    if (req.query.status && req.query.status !== 'all') query.status = req.query.status;
    if (req.query.day) query.day = String(req.query.day).trim();
    const commissions = await DailyCommission.find(query)
      .populate('beneficiaryId', 'name email glixId agencyCode')
      .populate('hostId', 'name email glixId')
      .sort({ day: -1, createdAt: -1 })
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

app.get('/admin/agency-targets', requireOfficial, async (req, res) => {
  try {
    const query = {};
    if (req.query.month) query.month = String(req.query.month).trim();
    if (req.query.status && req.query.status !== 'all') query.status = req.query.status;

    const targets = await AgencyTarget.find(query)
      .populate('agencyId', 'name email glixId agencyCode commissionBalance totalHostCoins')
      .populate('assignedBy', 'name email')
      .sort({ month: -1, createdAt: -1 })
      .lean();

    const totals = targets.reduce((acc, row) => {
      acc.targetCoins += row.targetCoins || 0;
      acc.achievedCoins += row.achievedCoins || 0;
      return acc;
    }, { targetCoins: 0, achievedCoins: 0 });

    return res.json({ success: true, targets, totals });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/agency-targets', requireOfficial, async (req, res) => {
  try {
    const agencyId = String(req.body?.agencyId || '').trim();
    const month = String(req.body?.month || getCommissionMonthKey()).trim();
    const targetCoins = Math.floor(Number(req.body?.targetCoins || 0));
    const commissionRatePercent = Number(req.body?.commissionRatePercent || AGENCY_COMMISSION_RATE_PERCENT || 10);
    const note = String(req.body?.note || '').trim();

    if (!mongoose.Types.ObjectId.isValid(agencyId)) {
      return res.status(400).json({ success: false, message: 'Valid agencyId is required' });
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, message: 'Month must use YYYY-MM format' });
    }
    if (!Number.isFinite(targetCoins) || targetCoins < 0) {
      return res.status(400).json({ success: false, message: 'Target coins must be zero or greater' });
    }
    if (!Number.isFinite(commissionRatePercent) || commissionRatePercent < 0) {
      return res.status(400).json({ success: false, message: 'Commission rate must be zero or greater' });
    }

    const agency = await User.findOne({
      _id: agencyId,
      $or: [{ role: 'agency' }, { roles: 'agency' }, { agencyStatus: 'approved' }],
    }).select('_id');
    if (!agency) return res.status(404).json({ success: false, message: 'Approved agency not found' });

    const target = await AgencyTarget.findOneAndUpdate(
      { agencyId, month },
      {
        $set: {
          targetCoins,
          commissionRatePercent,
          note,
          assignedBy: req.officialUser?._id || null,
        },
        $setOnInsert: { achievedCoins: 0 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate('agencyId', 'name email glixId agencyCode commissionBalance totalHostCoins');

    if (target.targetCoins > 0 && target.achievedCoins >= target.targetCoins && target.status !== 'achieved') {
      target.status = 'achieved';
      await target.save();
    }

    return res.json({ success: true, target });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/agency-targets/:targetId', requireOfficial, async (req, res) => {
  try {
    const target = await AgencyTarget.findById(req.params.targetId);
    if (!target) return res.status(404).json({ success: false, message: 'Target not found' });

    if (req.body?.targetCoins !== undefined) {
      const targetCoins = Math.floor(Number(req.body.targetCoins));
      if (!Number.isFinite(targetCoins) || targetCoins < 0) {
        return res.status(400).json({ success: false, message: 'Target coins must be zero or greater' });
      }
      target.targetCoins = targetCoins;
    }
    if (req.body?.commissionRatePercent !== undefined) {
      const commissionRatePercent = Number(req.body.commissionRatePercent);
      if (!Number.isFinite(commissionRatePercent) || commissionRatePercent < 0) {
        return res.status(400).json({ success: false, message: 'Commission rate must be zero or greater' });
      }
      target.commissionRatePercent = commissionRatePercent;
    }
    if (req.body?.status && ['pending', 'achieved', 'failed'].includes(req.body.status)) {
      target.status = req.body.status;
    }
    if (req.body?.note !== undefined) target.note = String(req.body.note || '').trim();

    if (target.targetCoins > 0 && target.achievedCoins >= target.targetCoins) {
      target.status = 'achieved';
    }

    await target.save();
    await target.populate('agencyId', 'name email glixId agencyCode commissionBalance totalHostCoins');
    return res.json({ success: true, target });
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

const serializeRoomMusicTrack = (track) => ({
  id: track._id?.toString?.() || String(track._id || ''),
  _id: track._id?.toString?.() || String(track._id || ''),
  title: track.title || 'Untitled track',
  name: track.title || 'Untitled track',
  artist: track.artist || '',
  type: track.type || 'song',
  url: track.url || '',
  path: track.url || '',
  coverUrl: track.coverUrl || '',
  durationMs: track.durationMs || 0,
  isShared: track.isShared !== false,
  isActive: track.isActive !== false,
  sortOrder: track.sortOrder || 0,
  createdAt: track.createdAt,
  updatedAt: track.updatedAt,
});

const uploadRoomMusicAsset = async (dataUri, folder, resourceType = 'auto') => {
  const cleanDataUri = typeof dataUri === 'string' ? dataUri.trim() : '';
  if (!cleanDataUri) return '';

  const result = await cloudinary.uploader.upload(cleanDataUri, {
    folder,
    resource_type: resourceType,
  });

  return result.secure_url || result.url || '';
};

app.get('/room-music/tracks', async (req, res) => {
  try {
    const type = String(req.query?.type || '').trim();
    const query = { isActive: true, isShared: true };
    if (['song', 'effect', 'sound_byte'].includes(type)) query.type = type;

    const tracks = await RoomMusicTrack.find(query)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: tracks.map(serializeRoomMusicTrack),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/admin/room-music/tracks', requireOfficial, async (req, res) => {
  try {
    const includeInactive = req.query?.includeInactive === 'true';
    const query = includeInactive ? {} : { isActive: true };
    const tracks = await RoomMusicTrack.find(query)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: tracks.map(serializeRoomMusicTrack),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/admin/room-music/tracks', requireOfficial, async (req, res) => {
  try {
    const title = String(req.body?.title || req.body?.name || '').trim();
    const type = String(req.body?.type || 'song').trim();
    const allowedTypes = ['song', 'effect', 'sound_byte'];
    if (!title) return res.status(400).json({ success: false, message: 'Track title is required' });
    if (!allowedTypes.includes(type)) return res.status(400).json({ success: false, message: 'Invalid track type' });

    const uploadedAudioUrl = req.body?.audioData
      ? await uploadRoomMusicAsset(req.body.audioData, 'room-music/audio', 'video')
      : '';
    const uploadedCoverUrl = req.body?.coverData
      ? await uploadRoomMusicAsset(req.body.coverData, 'room-music/covers', 'image')
      : '';
    const url = uploadedAudioUrl || String(req.body?.url || req.body?.audioUrl || '').trim();
    if (!url) return res.status(400).json({ success: false, message: 'Track audio URL or audioData is required' });

    const track = await RoomMusicTrack.create({
      title,
      artist: String(req.body?.artist || '').trim(),
      type,
      url,
      coverUrl: uploadedCoverUrl || String(req.body?.coverUrl || '').trim(),
      durationMs: Number(req.body?.durationMs || 0),
      sortOrder: Number(req.body?.sortOrder || 0),
      uploadedBy: req.officialUser?._id || null,
      isShared: req.body?.isShared !== false,
      isActive: req.body?.isActive !== false,
    });

    return res.status(201).json({ success: true, data: serializeRoomMusicTrack(track) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/admin/room-music/tracks/:trackId', requireOfficial, async (req, res) => {
  try {
    const { trackId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(trackId)) {
      return res.status(400).json({ success: false, message: 'Invalid track id' });
    }

    const updates = {};
    if (req.body?.title !== undefined || req.body?.name !== undefined) {
      updates.title = String(req.body.title || req.body.name || '').trim();
      if (!updates.title) return res.status(400).json({ success: false, message: 'Track title is required' });
    }
    if (req.body?.artist !== undefined) updates.artist = String(req.body.artist || '').trim();
    if (req.body?.type !== undefined) {
      const type = String(req.body.type || '').trim();
      if (!['song', 'effect', 'sound_byte'].includes(type)) {
        return res.status(400).json({ success: false, message: 'Invalid track type' });
      }
      updates.type = type;
    }
    if (req.body?.audioData) updates.url = await uploadRoomMusicAsset(req.body.audioData, 'room-music/audio', 'video');
    if (req.body?.url !== undefined || req.body?.audioUrl !== undefined) {
      updates.url = String(req.body.url || req.body.audioUrl || '').trim();
      if (!updates.url) return res.status(400).json({ success: false, message: 'Track audio URL is required' });
    }
    if (req.body?.coverData) updates.coverUrl = await uploadRoomMusicAsset(req.body.coverData, 'room-music/covers', 'image');
    if (req.body?.coverUrl !== undefined) updates.coverUrl = String(req.body.coverUrl || '').trim();
    if (req.body?.durationMs !== undefined) updates.durationMs = Number(req.body.durationMs || 0);
    if (req.body?.sortOrder !== undefined) updates.sortOrder = Number(req.body.sortOrder || 0);
    if (req.body?.isShared !== undefined) updates.isShared = !!req.body.isShared;
    if (req.body?.isActive !== undefined) updates.isActive = !!req.body.isActive;

    const track = await RoomMusicTrack.findByIdAndUpdate(trackId, updates, { new: true });
    if (!track) return res.status(404).json({ success: false, message: 'Track not found' });

    return res.json({ success: true, data: serializeRoomMusicTrack(track) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/admin/room-music/tracks/:trackId', requireOfficial, async (req, res) => {
  try {
    const { trackId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(trackId)) {
      return res.status(400).json({ success: false, message: 'Invalid track id' });
    }

    const track = await RoomMusicTrack.findByIdAndUpdate(trackId, { isActive: false }, { new: true });
    if (!track) return res.status(404).json({ success: false, message: 'Track not found' });

    return res.json({ success: true, data: serializeRoomMusicTrack(track) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});


app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: `API route not found: ${req.method} ${req.originalUrl}`,
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});





























