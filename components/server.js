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

// Real-time globally synchronized active tracking matrix map (userId -> socket.id)
const activeUsers = {};

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
  socket.on('join_audio_room', async ({ roomId, userId, name, profilePic, entryVideoUrl }) => {
    try {
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

      socket.to(stringRoomId).emit('user_joined_channel', {
        userId,
        name,
        profilePic,
        entryVideoUrl: entryVideoUrl || null,
        message: `${name} entered the room.`
      });

      if (entryVideoUrl) {
        socket.emit('play_my_own_entry_effect', { entryVideoUrl });
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
      }

      socket.emit('initialize_room_slots', completeLayoutMatrix);

    } catch (err) {
      console.log("Error inside join initialization workflow logic: ", err);
    }
  });

  // 2. EVENT: Request Slot Change
  socket.on('request_slot_change', async ({ roomId, userId, name, profilePic, targetSlotIndex, numericUid, isMuted }) => {
    try {
      const stringRoomId = roomId ? roomId.toString() : '';
      const isVideoRoom = stringRoomId.startsWith('glix_');
      const queryFilter = isVideoRoom ? { channelName: stringRoomId } : { _id: stringRoomId };

      if (isVideoRoom) {
        const updateData = profilePic === null
          ? {
            "slots.$.uid": null,
            "slots.$.username": targetSlotIndex === 0 ? 'Main Host' : `Co-Host ${targetSlotIndex + 1}`,
            "slots.$.avatar": null,
            "slots.$.isMuted": false
          }
          : {
            "slots.$.uid": parseInt(numericUid, 10),
            "slots.$.username": name,
            "slots.$.avatar": profilePic,
            "slots.$.isMuted": !!isMuted
          };

        await Room.findOneAndUpdate(
          { channelName: stringRoomId, "slots.id": targetSlotIndex + 1 },
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
                isMuted: isMuted || false
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
    const stringRoomId = roomId ? roomId.toString() : '';
    io.to(stringRoomId).emit('receive_message', {
      id: Date.now().toString() + Math.random().toString(),
      type: 'user',
      sender: senderName,
      text: text,
      userId: userId
    });
  });

  // 4. EVENT: Gift Broadcasts
  socket.on('send_gift', ({ roomId, senderName, gift, giftName, avatar, userId, quantity }) => {
    const stringRoomId = roomId ? roomId.toString() : '';
    io.to(stringRoomId).emit('receive_gift', {
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

  // 5. EVENT: Audience Mic Requests (Correctly Un-nested now)
  socket.on('audience_join_request', (data) => {
    if (!data.hostId) return;
    const hostSocketId = activeUsers[data.hostId.toString()];

    if (hostSocketId) {
      io.to(hostSocketId).emit('receive_join_request', data);
    } else {
      io.to(data.roomId.toString()).emit('receive_join_request', data);
    }
  });

  // 6. EVENT: Host Acceptance Decision System Handler
  socket.on('host_request_response', (data) => {
    const stringRoomId = data.roomId ? data.roomId.toString() : '';
    io.to(stringRoomId).emit('join_request_result', data);

    if (data.accepted && data.user) {
      io.to(stringRoomId).emit('slot_state_changed', {
        slotIndex: data.requestedSlotIndex,
        user: {
          uid: data.user.uid,
          username: data.user.username,
          avatar: data.user.avatar,
          isMuted: false
        }
      });
    }
  });

  // 7. EVENT: Safe Disconnect Handler
  socket.on('disconnect', async () => {
    try {
      if (socket.userId) {
        delete activeUsers[socket.userId.toString()];
      }

      if (!socket.roomId || !socket.userId) return;

      const roomId = socket.roomId.toString();
      const currentUserId = socket.userId.toString();

      if (roomId.startsWith('glix_')) {
        const videoRoomDoc = await Room.findOne({ channelName: roomId });

        if (videoRoomDoc && videoRoomDoc.hostId.toString() === currentUserId) {
          io.to(roomId).emit('room_closing', {
            message: 'Host disconnected. Room closed.'
          });

          setTimeout(async () => {
            const checkRoom = await Room.findOne({ channelName: roomId });
            if (!checkRoom) return;

            const members = io.sockets.adapter.rooms.get(roomId);
            if (!members || members.size === 0) {
              await Room.deleteOne({ channelName: roomId });
              console.log(`[Database Cleanup] Video Room ${roomId} dropped successfully.`);
            }
          }, 15000);

          console.log(`Video room closed because host disconnected: ${roomId}`);
        }
        return;
      }

      if (!roomId || roomId.length !== 24 || !/^[0-9a-fA-F]{24}$/.test(roomId)) {
        return;
      }

      const audioRoomDoc = await AudioRoom.findById(roomId);

      if (audioRoomDoc && audioRoomDoc.hostId.toString() === currentUserId) {
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
    const stringRoomId = roomId.toString();
    const isVideoRoom = stringRoomId.startsWith('glix_');

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    let roomObj = null;

    if (isVideoRoom) {
      roomObj = await Room.findOne({ channelName: stringRoomId });
      if (!roomObj) return res.status(404).json({ error: "Video room not found" });
    } else {
      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return res.status(400).json({ error: "Invalid Room ID format" });
      roomObj = await AudioRoom.findById(stringRoomId);
      if (!roomObj) return res.status(404).json({ error: "Audio room not found" });
      if (!roomObj.isLive) return res.status(400).json({ error: "This room has already ended" });

      const isAlreadySpeaker = roomObj.speakers.some(s => s.userId === userId);
      const isAlreadyAudience = roomObj.audience.includes(userId);
      if (!isAlreadySpeaker && !isAlreadyAudience) {
        roomObj.audience.push(userId);
        await roomObj.save();
      }
    }

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      stringRoomId,
      sanitizedUid,
      RtcRole.SUBSCRIBER,
      privilegeExpiredTs
    );
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
      appId: appId
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

    if (stringRoomId.startsWith('glix_')) {
      const room = await Room.findOne({ channelName: stringRoomId });

      if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
      if (room.hostId.toString() !== hostId.toString()) return res.status(403).json({ success: false, error: 'Unauthorized' });

      io.to(stringRoomId).emit('room_closing', { message: 'The host has ended the video live stream.' });
      await Room.deleteOne({ channelName: stringRoomId });
      await new Promise(resolve => setTimeout(resolve, 500));

    } else {
      if (!mongoose.Types.ObjectId.isValid(stringRoomId)) return res.status(400).json({ error: "Malformed ID structure" });

      const room = await AudioRoom.findById(stringRoomId);
      if (room && room.hostId.toString() === hostId) {
        room.isLive = false;
        room.speakers = [];
        room.audience = [];
        await room.save();

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
    const liveRooms = await Room.find().sort({ createdAt: -1 });
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
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid identity sequence format" });
    const user = await User.findById(id).select('-password');
    return res.status(200).json(user);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});