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

io.on('connection', (socket) => {
  console.log(`User connected to socket cluster: ${socket.id}`);

  // 1. EVENT: Join Room
  socket.on('join_audio_room', ({ roomId, userId, name, profilePic }) => {
    socket.join(roomId);

    socket.roomId = roomId;
    socket.userId = userId;
    socket.userName = name;

    console.log(`${name} joined real-time room channel: ${roomId}`);

    // Notify everyone else in the room dynamically
    socket.to(roomId).emit('user_joined_channel', {
      userId,
      name,
      profilePic,
      message: `${name} entered the room.`
    });
  });

  // 2. EVENT: Change/Sit on Mic Slot
  // 2. EVENT: Change/Sit on Mic Slot or Toggle Mute Status
  socket.on('request_slot_change', async ({ roomId, userId, name, profilePic, targetSlotIndex, numericUid, isMuted }) => {
    try {
      console.log(`${name} requested slot ${targetSlotIndex}. Mute status: ${isMuted}`);

      if (profilePic === null) {
        // SCENARIO A: User stepped down or left slot -> Clear slot out of MongoDB
        await AudioRoom.findByIdAndUpdate(roomId, {
          $pull: { speakers: { slotIndex: targetSlotIndex } }
        });
      } else {
        // SCENARIO B: User sits on a new slot or changed their mute condition
        // Remove their record from old slot array elements first (Seat Jump Protection)
        await AudioRoom.findByIdAndUpdate(roomId, {
          $pull: { speakers: { userId: userId } }
        });

        // Push new record context including the active mute track parameter
        await AudioRoom.findByIdAndUpdate(roomId, {
          $push: {
            speakers: {
              userId: userId,
              slotIndex: targetSlotIndex,
              numericUid: parseInt(numericUid, 10),
              isMuted: isMuted || false // Save mic condition to MongoDB
            }
          }
        });
      }

      // Broadcast the slot update alongside the mic track condition to EVERY client in the channel uniformly
      io.to(roomId).emit('slot_state_changed', {
        slotIndex: targetSlotIndex,
        user: {
          uid: numericUid ? parseInt(numericUid, 10) : null,
          userId,
          username: name,
          avatar: profilePic,
          isMuted: isMuted || false // 👈 CRITICAL: Emits real-time state change status to all devices
        }
      });

    } catch (error) {
      console.log("Socket array persistence exception error:", error);
      socket.emit('error_notice', { message: 'Failed to synchronize layout seat state.' });
    }
  });

  socket.on('send_message', ({ roomId, senderName, text, userId }) => {
    console.log(`[Chat] Message from ${senderName} in room ${roomId}: ${text}`);

    // Broadcast the message to EVERYONE in the room (including the sender)
    io.to(roomId).emit('receive_message', {
      id: Date.now().toString() + Math.random().toString(), // Added random modifier to make ID 100% unique
      type: 'user',
      sender: senderName,
      text: text,
      userId: userId
    });
  });

socket.on('send_gift', ({ roomId, senderName, gift, giftName, avatar, userId, quantity }) => {
    console.log(`[Chat] Gift from ${senderName} in room ${roomId}: ${giftName || gift} (Quantity: ${quantity})`);

    // Broadcast the gift to EVERYONE in the room (including the sender)
    io.to(roomId).emit('receive_gift', {
        id: Date.now().toString() + Math.random().toString(), // 100% unique ID
        type: 'gift',
        sender: senderName,
        gift: gift,            // This is your icon PNG / URI asset
        giftName: giftName,    // Added: Clear text name for actionText prop
        avatar: avatar,        // Added: Sender's profilePic for avatarUrl prop
        quantity: quantity,
        userId: userId
    });
});

// 3. EVENT: Automatic Disconnect Cleanup
socket.on('disconnect', () => {
  if (socket.roomId && socket.userId) {
    console.log(`${socket.userName} disconnected unexpectedly.`);
    io.to(socket.roomId).emit('user_left_channel', {
      userId: socket.userId,
      message: `${socket.userName} left the room.`
    });
  }
});
});

app.post('/create', async (req, res) => {
  try {
    const { title, hostId, numericUid } = req.body;
    const sanitizedUid = parseInt(numericUid, 10) || 0;

    const newRoom = new AudioRoom({
      title: title || "Live Audio Room",
      hostId,
      isLive: true,
      speakers: [{ userId: hostId, isMuted: false, slotIndex: 0 }],
      audience: []
    });
    await newRoom.save();

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const channelName = newRoom._id.toString();

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      sanitizedUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

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

    if (!roomId || !userId || !numericUid) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const sanitizedUid = parseInt(numericUid, 10) || 0;

    const room = await AudioRoom.findById(roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (!room.isLive) return res.status(400).json({ error: "This room has already ended" });

    const isAlreadySpeaker = room.speakers.some(s => s.userId === userId);
    const isAlreadyAudience = room.audience.includes(userId);

    if (!isAlreadySpeaker && !isAlreadyAudience) {
      room.audience.push(userId);
      await room.save();
    }

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const channelName = room._id.toString();

    // FIXED: Generate the token as a PUBLISHER so they have the crypt-key permission to speak later!
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      sanitizedUid,
      RtcRole.PUBLISHER, // 👈 FIXED HERE
      privilegeExpiredTs
    );

    return res.status(200).json({
      success: true,
      room,
      agoraToken: token,
      channelName: channelName,
      appId: appId
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/rooms/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await AudioRoom.findById(roomId)
      .populate('hostId', 'name profilePic username')
      .populate('speakers.userId', 'name profilePic username')
      .populate('audience', 'name profilePic username');

    if (!room) return res.status(404).json({ error: "Room not found" });
    if (!room.isLive) return res.status(400).json({ error: "This room is no longer active" });

    return res.status(200).json({ success: true, room });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/rooms', async (req, res) => {
  try {
    const liveRooms = await AudioRoom.find({ isLive: true })
      .populate('hostId', 'name profilePic username')
      .sort({ createdAt: -1 });

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

app.post('/rooms/end', async (req, res) => {
  try {
    const { roomId, hostId } = req.body;
    const room = await AudioRoom.findById(roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });

    if (room.hostId.toString() !== hostId) {
      return res.status(403).json({ error: "Unauthorized: Only the host can end this room." });
    }

    room.isLive = false;
    room.endAt = new Date();
    room.speakers = [];
    room.audience = [];
    await room.save();

    return res.status(200).json({ success: true, message: "Room closed cleanly." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { name, email, password, profilePic, googleId } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Name and email are required.' });

    let user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      user.lastLogin = new Date();
      if (googleId && !user.googleId) user.googleId = googleId;
      await user.save();
      return res.status(200).json({
        message: 'User already exists. Login successful!',
        user: { id: user._id, name: user.name, email: user.email, profilePic: user.profilePic, googleId: user.googleId }
      });
    }

    let hashedPassword = null;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      hashedPassword = await bcrypt.hash(password, salt);
    } else if (!googleId) {
      return res.status(400).json({ message: 'Password is required for standard email registration.' });
    }

    const newUser = new User({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      profilePic: profilePic || '',
      googleId: googleId || null,
      createdAt: new Date(),
      lastLogin: new Date()
    });
    await newUser.save();

    return res.status(201).json({
      message: 'User registered successfully!',
      user: { id: newUser._id, name: newUser.name, email: newUser.email, profilePic: newUser.profilePic, googleId: newUser.googleId }
    });
  } catch (error) {
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

app.get('/profile/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: 'No user found with this ID.' });
    return res.status(200).json(user);
  } catch (error) {
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

// CRITICAL: Listen to the server module wrapper, NOT the raw express app instance!
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});