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
      const userData = await User.findById(userId).select('frameUrl');
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

      socket.to(stringRoomId).emit('user_joined_channel', {
        userId,
        name,
        profilePic,
        entryVideoUrl: entryVideoUrl || null,
        frameUrl: frameUrl || null,
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
                  frameUrl: speaker.frameUrl || null,
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
  socket.on('request_slot_change', async ({ roomId, userId, name, profilePic, frameUrl, targetSlotIndex, numericUid, isMuted }) => {
    try {

      let finalFrameUrl = frameUrl;

      // Fetch from DB only if the client didn't send a frameUrl
      if (!finalFrameUrl) {
        const dbUser = await User.findById(userId).select('frameUrl');
        finalFrameUrl = dbUser?.frameUrl || null;
      }

      const stringRoomId = roomId ? roomId.toString() : '';
      const isVideoRoom = stringRoomId.startsWith('glix_');
      const queryFilter = isVideoRoom ? { channelName: stringRoomId } : { _id: stringRoomId };

      if (isVideoRoom) {
        const updateData = profilePic === null
          ? {
            "slots.$.uid": null,
            "slots.$.username": targetSlotIndex === 0 ? 'Main Host' : `Co-Host ${targetSlotIndex + 1}`,
            "slots.$.avatar": null,
            "slots.$.frameUrl": null,
            "slots.$.isMuted": false
          }
          : {
            "slots.$.uid": parseInt(numericUid, 10),
            "slots.$.username": name,
            "slots.$.avatar": profilePic,
            "slots.$.frameUrl": finalFrameUrl,
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
                isMuted: isMuted || false,
                frameUrl: frameUrl
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

  socket.on('send_gift', async ({ roomId, senderName, hostId, gift, giftName, avatar, userId, quantity, coins }) => {

    console.log('gift data:', userId, roomId, hostId, coins);

    if (!hostId) {
      console.error("Backend Error: Received null hostId!");
      socket.emit('gift_error', { message: "Invalid host ID received." });
      return;
    }

    const totalCost = coins * quantity;

    const session = await mongoose.startSession();
    session.startTransaction();


    try {
      const sender = await User.findByIdAndUpdate(
        userId,
        { $inc: { daimon: -totalCost } },
        { new: true, session }
      );

      if (!sender || sender.daimon < 0) throw new Error("Insufficient funds");

      // 2. Add to Receiver (Host)
      await User.findByIdAndUpdate(
        hostId,
        { $inc: { daimon: totalCost } },
        { session }
      );

      await GiftTransaction.create({
        roomId,
        senderId: userId,
        receiverId: hostId,
        giftName,
        giftImage: gift,
        coinPrice: coins,
        quantity,
        totalCost
      });


      await session.commitTransaction();

    } catch (error) {
      await session.abortTransaction();
      // Emit error back to the sender only
      socket.emit('gift_error', { message: error.message });
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
      quantity: quantity,
      totalCost,
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
          frameUrl: data.user.frameUrl || null,
          isMuted: false
        }
      });
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

  // Add this to your io.on('connection', (socket) => { ... })
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

    // 1. Fetch user basic info
    const user = await User.findById(userId).select('-password'); // Exclude password for security

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 2. Aggregate to find mutual friends count
    const result = await Follow.aggregate([
      { $match: { follower: new mongoose.Types.ObjectId(userId) } },
      {
        $lookup: {
          from: 'follows',
          let: { followingId: '$following' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$follower', '$$followingId'] },
                    { $eq: ['$following', new mongoose.Types.ObjectId(userId)] }
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

    const result = await GiftTransaction.aggregate([
      {
        $match: {
          roomId: new mongoose.Types.ObjectId(roomId)
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