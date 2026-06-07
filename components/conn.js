import 'dotenv/config'; 
import mongoose from 'mongoose';

mongoose.set('strictQuery', false);

// A clean delay helper to wait for the environment to settle
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function checkConnection() {
  // Give Railway a brief moment to inject environment variables into memory
  await wait(500);

  // Read MONGO_URI fallback to MONGODB_URI just in case
  const mongoURI = process.env.MONGO_URI || process.env.MONGODB_URI;

  if (!mongoURI) {
    console.error("❌ CRITICAL REASON FOR CRASH:");
    console.error("process.env.MONGO_URI is completely UNDEFINED.");
    console.log("Keys available to Railway right now:", Object.keys(process.env));
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoURI);
    console.log('✅ Connected to MongoDB successfully!');
    console.log(`Connection state: ${mongoose.connection.readyState}`);
  } catch (error) {
    console.error(`❌ Mongoose connection error: ${error.message}`);
    process.exit(1);  
  }
}

checkConnection();