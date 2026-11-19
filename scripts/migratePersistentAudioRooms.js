import 'dotenv/config';
import crypto from 'crypto';
import mongoose from 'mongoose';

import AudioRoom from '../components/AudioRoom.js';
import User from '../components/User.js';

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;

const createLiveSessionId = () => (
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex')
);

const buildRoomTitle = (user = {}) => {
  const name = String(user.name || '').trim();
  return name ? `${name}'s Room` : 'My Voice Room';
};

const run = async () => {
  if (!mongoUri) throw new Error('MONGO_URI or MONGODB_URI is required.');

  await mongoose.connect(mongoUri, { autoIndex: false });

  const rooms = await AudioRoom.find({}).select(
    '_id isLive liveSessionId liveStartedAt liveEndedAt gracePeriodEndsAt endedAt createdAt administrators'
  ).lean();

  if (rooms.length) {
    await AudioRoom.bulkWrite(rooms.map(room => {
      const isLive = room.isLive === true;
      const update = {
        isLive,
        administrators: Array.isArray(room.administrators) ? room.administrators : [],
        liveSessionId: isLive ? (room.liveSessionId || createLiveSessionId()) : (room.liveSessionId || null),
        liveStartedAt: isLive ? (room.liveStartedAt || room.createdAt || new Date()) : (room.liveStartedAt || null),
        liveEndedAt: isLive ? null : (room.liveEndedAt || room.endedAt || null),
        gracePeriodEndsAt: isLive ? (room.gracePeriodEndsAt || null) : null,
      };

      if (!isLive) {
        update.speakers = [];
        update.audience = [];
        update.activeGamePlayers = [];
      }

      return {
        updateOne: {
          filter: { _id: room._id },
          update: { $set: update },
        }
      };
    }), { ordered: false });
  }

  const duplicateHosts = await AudioRoom.aggregate([
    { $match: { isPermanent: true } },
    { $sort: { isLive: -1, createdAt: 1, _id: 1 } },
    { $group: { _id: '$hostId', roomIds: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  let duplicateRoomsDemoted = 0;
  for (const group of duplicateHosts) {
    const duplicateIds = group.roomIds.slice(1);
    if (!duplicateIds.length) continue;

    const result = await AudioRoom.updateMany(
      { _id: { $in: duplicateIds } },
      {
        $set: {
          isPermanent: false,
          isLive: false,
          speakers: [],
          audience: [],
          activeGamePlayers: [],
          gracePeriodEndsAt: null,
          liveEndedAt: new Date(),
          endedAt: new Date(),
        }
      }
    );
    duplicateRoomsDemoted += result.modifiedCount ?? result.nModified ?? 0;
  }

  const hosts = await User.find({
    $or: [
      { hostStatus: 'approved' },
      { role: 'host' },
      { roles: 'host' },
    ]
  }).select('_id name').lean();

  let permanentRoomsCreated = 0;
  for (const host of hosts) {
    const existingRoom = await AudioRoom.exists({ hostId: host._id, isPermanent: true });
    if (existingRoom) continue;

    await AudioRoom.create({
      title: buildRoomTitle(host),
      hostId: host._id,
      speakers: [],
      audience: [],
      activeGamePlayers: [],
      lockedSlots: [3, 12, 19],
      administrators: [],
      isPermanent: true,
      visibility: 'followers',
      isLive: false,
      liveSessionId: null,
      liveStartedAt: null,
      liveEndedAt: null,
      gracePeriodEndsAt: null,
      endedAt: null,
      lastHeartbeatAt: new Date(),
    });
    permanentRoomsCreated += 1;
  }

  await AudioRoom.collection.createIndex(
    { hostId: 1, isPermanent: 1 },
    {
      unique: true,
      partialFilterExpression: { isPermanent: true },
      name: 'one_permanent_audio_room_per_host',
    }
  );

  console.log(JSON.stringify({
    roomsBackfilled: rooms.length,
    duplicateRoomsDemoted,
    approvedHostsChecked: hosts.length,
    permanentRoomsCreated,
  }, null, 2));
};

run()
  .catch(error => {
    console.error('Persistent audio room migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
