import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import OfficialUser from '../components/OfficialUser.js';

const mongoURI = process.env.MONGO_URI || process.env.MONGODB_URI;
const name = process.env.OFFICIAL_SUPER_ADMIN_NAME || 'Super Admin';
const email = String(process.env.OFFICIAL_SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.OFFICIAL_SUPER_ADMIN_PASSWORD || '');

if (!mongoURI) throw new Error('MONGO_URI or MONGODB_URI is required');
if (!email || password.length < 6) throw new Error('OFFICIAL_SUPER_ADMIN_EMAIL and OFFICIAL_SUPER_ADMIN_PASSWORD are required');

await mongoose.connect(mongoURI);

const account = await OfficialUser.findOne({ email });
if (account) {
  account.name = account.name || name;
  account.role = 'super_admin';
  account.status = 'active';
  if (process.env.OFFICIAL_SUPER_ADMIN_RESET_PASSWORD === 'true') {
    account.password = await bcrypt.hash(password, 10);
  }
  await account.save();
  console.log(`Official Super Admin ready: ${email}`);
} else {
  await OfficialUser.create({
    name,
    email,
    password: await bcrypt.hash(password, 10),
    role: 'super_admin',
    status: 'active',
    reviewedAt: new Date(),
  });
  console.log(`Official Super Admin created: ${email}`);
}

await mongoose.disconnect();
