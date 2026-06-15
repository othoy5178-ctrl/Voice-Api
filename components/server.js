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

const createCleanSlotsBlueprint = () => Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  locked: i === 3 || i === 12 || i === 19, 
  uid: null,
  username: `${i + 1}`,
  avatar: null,
  isMuted: false
}));

io.on('connection', (socket) => {
  console.log(`User connected to socket cluster: ${socket.id}`);

  // 1. EVENT: Join Room
  socket.on('join_audio_room', async ({ roomId, userId, name, profilePic }) => {
    try {
      socket.join(roomId);
      socket.roomId = roomId;
      socket.userId = userId;
      socket.userName = name;

      console.log(`${name} joined real-time room channel: ${roomId}`);

      socket.to(roomId).emit('user_joined_channel', {
        userId,
        name,
        profilePic,
        message: `${name} entered the room.`
      });

      const isVideoRoom = roomId.startsWith('glix_');
      let completeLayoutMatrix = createCleanSlotsBlueprint();

      if (isVideoRoom) {
        const videoRoomDoc = await Room.findOne({ channelName: roomId });
        if (videoRoomDoc && videoRoomDoc.slots) {
          completeLayoutMatrix = videoRoomDoc.slots;
        }
      } else {
        const audioRoomDoc = await AudioRoom.findById(roomId).populate('speakers.userId', 'name profilePic');
        if (audioRoomDoc && audioRoomDoc.speakers) {
          audioRoomDoc.speakers.forEach(speaker => {
            const index = speaker.slotIndex;
            if (index >= 0 && index < 25) {
              completeLayoutMatrix[index] = {
                ...completeLayoutMatrix[index],
                uid: speaker.numericUid || null,
                username: speaker.userId?.name || "Broadcaster",
                avatar: speaker.userId?.profilePic || null,
                isMuted: speaker.isMuted || false
              };
            }
          });
        }
      }

      socket.emit('initialize_room_slots', completeLayoutMatrix);

    } catch (err) {
      console.log("Error inside join initialization workflow logic: ", err);
    }
  });

  // 2. EVENT: Request Slot Change
  socket.on('request_slot_change', async ({ roomId, userId, name, profilePic, targetSlotIndex, numericUid, isMuted }) => {
    try {
      const isVideoRoom = roomId.startsWith('glix_');
      const queryFilter = isVideoRoom ? { channelName: roomId } : { _id: roomId };

      if (profilePic === null) {
        if (isVideoRoom) {
          await Room.findOneAndUpdate(queryFilter, {
            $set: { [`slots.${targetSlotIndex}`]: { id: targetSlotIndex + 1, locked: false, uid: null, username: targetSlotIndex === 0 ? 'Main Host' : `Co-Host ${targetSlotIndex}`, avatar: null, isMe: false, isMuted: false } }
          });
        } else {
          await AudioRoom.findOneAndUpdate(queryFilter, {
            $pull: { speakers: { slotIndex: targetSlotIndex } }
          });
        }
      } else {
        if (isVideoRoom) {
          await Room.findOneAndUpdate(queryFilter, {
            $set: {
              [`slots.${targetSlotIndex}`]: {
                id: targetSlotIndex + 1,
                locked: false,
                uid: parseInt(numericUid, 10),
                username: name,
                avatar: profilePic,
                isMe: false,
                isMuted: !!isMuted
              }
            }
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
                isMuted: isMuted || false
              }
            }
          });
        }
      }

      io.to(roomId).emit('slot_state_changed', {
        slotIndex: targetSlotIndex,
        user: {
          uid: numericUid ? parseInt(numericUid, 10) : null,
          userId,
          username: name,
          avatar: profilePic,
          isMuted: isMuted || false
        }
      });

    } catch (error) {
      console.log("Socket array persistence exception error:", error);
      socket.emit('error_notice', { message: 'Failed to synchronize layout seat state.' });
    }
  });

  // 3. EVENT: Chat Messages
  socket.on('send_message', ({ roomId, senderName, text, userId }) => {
    
    io.to(roomId).emit('receive_message', {
      id: Date.now().toString() + Math.random().toString(), 
      type: 'user',
      sender: senderName,
      text: text,
      userId: userId
    });
  });

  // 4. EVENT: Gift Broadcasts
  socket.on('send_gift', ({ roomId, senderName, gift, giftName, avatar, userId, quantity }) => {
    io.to(roomId).emit('receive_gift', {
        id: Date.now().toString() + Math.random().toString(), 
        type: 'gift',
        sender: senderName,
        gift: gift,            
        giftName: giftName,    
        avatar: avatar,        
        quantity: quantity,
        userId: userId
    });
  });

  // 5. EVENT: Disconnect
  socket.on('disconnect', () => {
    if (socket.roomId && socket.userId) {
      io.to(socket.roomId).emit('user_left_channel', {
        userId: socket.userId,
        message: `${socket.userName} left the room.`
      });
    }
  });
});

// --- HTTP ENDPOINTS ---

app.post('/create-video', async (req, res) => {
  try {
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    const { hostId, title, numericUid } = req.body;
    if (!hostId) return res.status(400).json({ success: false, error: 'Host identifier missing' });

    const uniqueChannelName = `glix_${hostId}_${Date.now().toString().slice(-4)}`;
    
    const initialSlots = [
      { id: 1, locked: false, uid: parseInt(numericUid, 10), username: 'Host', avatar: null, isMe: false, isMuted: false },
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

    const token = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, uniqueChannelName, parseInt(numericUid, 10), RtcRole.PUBLISHER, privilegeExpiredTs);

    return res.status(200).json({
      success: true,
      room: { hostId: newRoom.hostId, _id: newRoom._id },
      channelName: uniqueChannelName,
      agoraToken: token,
      appId: appId
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
    const isVideoRoom = roomId.startsWith('glix_');

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    let roomObj = null;

    if (isVideoRoom) {
      roomObj = await Room.findOne({ channelName: roomId });
      if (!roomObj) return res.status(404).json({ error: "Video room not found" });
    } else {
      roomObj = await AudioRoom.findById(roomId);
      if (!roomObj) return res.status(404).json({ error: "Audio room not found" });
      if (!roomObj.isLive) return res.status(400).json({ error: "This room has already ended" });

      const isAlreadySpeaker = roomObj.speakers.some(s => s.userId === userId);
      const isAlreadyAudience = roomObj.audience.includes(userId);
      if (!isAlreadySpeaker && !isAlreadyAudience) {
        roomObj.audience.push(userId);
        await roomObj.save();
      }
    }

    const token = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, roomId, sanitizedUid, RtcRole.PUBLISHER, privilegeExpiredTs);

    return res.status(200).json({
      success: true,
      room: { hostId: roomObj.hostId },
      agoraToken: token,
      channelName: roomId,
      appId: appId
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/rooms/end', async (req, res) => {
  try {
    const { roomId, hostId } = req.body;
    if (roomId.startsWith('glix_')) {
      await Room.deleteOne({ channelName: roomId, hostId });
    } else {
      const room = await AudioRoom.findById(roomId);
      if (room && room.hostId.toString() === hostId) {
        room.isLive = false;
        room.speakers = [];
        room.audience = [];
        await room.save();
      }
    }
    return res.status(200).json({ success: true, message: "Room closed cleanly." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ... keep all other routes unmodified (profile, register, rooms listing)
app.get('/rooms/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
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
    const liveRooms = await Room.find().populate('hostId', 'name profilePic username').sort({ createdAt: -1 });
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
    let user = await User.findOne({ email: email.toLowerCase() });
    if (user) return res.status(200).json({ message: 'Login successful!', user: { id: user._id, name: user.name, email: user.email } });
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = password ? await bcrypt.hash(password, salt) : null;
    const newUser = new User({ name, email: email.toLowerCase(), password: hashedPassword, profilePic: profilePic || '', googleId: googleId || null });
    await newUser.save();
    return res.status(201).json({ message: 'Registered!', user: { id: newUser._id, name: newUser.name } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get('/profile/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    return res.status(200).json(user);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});