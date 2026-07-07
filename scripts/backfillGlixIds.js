import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../components/User.js';

const mongoURI = process.env.MONGO_URI || process.env.MONGODB_URI;

const generateSevenDigitUserId = () => Math.floor(1000000 + Math.random() * 9000000).toString();

const createUniqueGlixId = (usedIds) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const glixId = generateSevenDigitUserId();
    if (!usedIds.has(glixId)) {
      usedIds.add(glixId);
      return glixId;
    }
  }
  throw new Error('Unable to generate unique 7-digit user ID');
};

async function backfillGlixIds() {
  if (!mongoURI) {
    throw new Error('MONGO_URI or MONGODB_URI is required');
  }

  await mongoose.connect(mongoURI);

  const existingUsers = await User.find({ glixId: { $type: 'string', $ne: '' } }).select('glixId').lean();
  const usedIds = new Set(existingUsers.map(user => user.glixId));

  const usersMissingGlixId = await User.find({
    $or: [
      { glixId: { $exists: false } },
      { glixId: null },
      { glixId: '' },
    ],
  }).select('_id email name').lean();

  let updated = 0;

  for (const user of usersMissingGlixId) {
    const glixId = createUniqueGlixId(usedIds);
    const result = await User.updateOne(
      {
        _id: user._id,
        $or: [
          { glixId: { $exists: false } },
          { glixId: null },
          { glixId: '' },
        ],
      },
      { $set: { glixId } }
    );

    if (result.modifiedCount > 0) {
      updated += 1;
      console.log(`Updated ${user._id} (${user.email || user.name || 'unknown'}): ${glixId}`);
    }
  }

  console.log(`Backfill complete. Missing before: ${usersMissingGlixId.length}. Updated: ${updated}. Existing kept: ${existingUsers.length}.`);
}

backfillGlixIds()
  .catch(error => {
    console.error('Backfill failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
