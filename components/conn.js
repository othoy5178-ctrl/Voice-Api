import 'dotenv/config';
import mongoose from 'mongoose';
mongoose.set('strictQuery', false);



async function checkConnection() {

  const mongoURI = process.env.MONGO_URI;

  try {
   await mongoose.connect(mongoURI);
    console.log('Connected to MongoDB');

    const state = mongoose.connection.readyState;
    console.log(`Connection state: ${state}`);

    
   
  } catch (error) {
    console.error(`Connection error: ${error.message}`);
    process.exit(1);  
}
   
}

process.on('uncaughtException', err => {
    console.error(`Uncaught exception: ${err}`);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error(`Unhandled rejection at ${promise}, reason: ${reason}`);
    process.exit(1);
  });

checkConnection();