import 'dotenv/config';
import fs from 'fs';
import mongoose from 'mongoose';
import StoreItem from '../components/StoreItem.js';

const serverPath = new URL('../components/server.js', import.meta.url);
const source = fs.readFileSync(serverPath, 'utf8');
const match = source.match(/const DEFAULT_STORE_ITEMS = (\[[\s\S]*?\n\]);/);

if (!match) {
  console.error('Could not find DEFAULT_STORE_ITEMS in components/server.js');
  process.exit(1);
}

const itemKeyPrefix = process.argv[2] || '';
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!mongoUri) {
  console.error('MONGO_URI is missing.');
  process.exit(1);
}

let defaultItems = [];

try {
  defaultItems = Function(`"use strict"; return (${match[1]});`)();
} catch (error) {
  console.error('Could not parse DEFAULT_STORE_ITEMS:', error.message);
  process.exit(1);
}

const itemsToSeed = itemKeyPrefix
  ? defaultItems.filter(item => item.itemKey?.startsWith(itemKeyPrefix))
  : defaultItems;

if (!itemsToSeed.length) {
  console.log(`No store items found${itemKeyPrefix ? ` for prefix ${itemKeyPrefix}` : ''}.`);
  process.exit(0);
}

await mongoose.connect(mongoUri);

const result = await StoreItem.bulkWrite(
  itemsToSeed.map(item => ({
    updateOne: {
      filter: { itemKey: item.itemKey },
      update: { $set: { ...item, isActive: item.isActive !== false } },
      upsert: true,
    },
  })),
  { ordered: false }
);

console.log(`Seeded ${itemsToSeed.length} store items.`);
console.log({
  matched: result.matchedCount,
  modified: result.modifiedCount,
  upserted: result.upsertedCount,
});

await mongoose.disconnect();
