const mongoose = require('mongoose');

const MONGO_URI = "mongodb+srv://GaPP:Ammy%40123@cluster0.mv3zr.mongodb.net/gapp?retryWrites=true&w=majority&appName=Cluster0";

async function connectWithRetry() {
  for (let i = 0; i < 3; i++) {
    try {
      await mongoose.connect(MONGO_URI, {
        connectTimeoutMS: 30000,
        socketTimeoutMS: 30000,
        serverSelectionTimeoutMS: 5000,
      });
      console.log('Connected to MongoDB successfully');
      return;
    } catch (err) {
      console.log(`Connection attempt ${i + 1} failed: ${err.message}`);
      if (i < 2) await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
    }
  }
  throw new Error('Failed to connect after 3 attempts');
}

async function dropIndexes() {
  try {
    await connectWithRetry();
    const db = mongoose.connection;

    const usersIndexes = await db.collection('users').indexes();
    const messagesIndexes = await db.collection('messages').indexes();

    if (usersIndexes.length > 1) {
      await db.collection('users').dropIndexes();
      console.log('Indexes dropped from "users" collection');
    } else {
      console.log('No custom indexes in "users" collection');
    }

    if (messagesIndexes.length > 1) {
      await db.collection('messages').dropIndexes();
      console.log('Indexes dropped from "messages" collection');
    } else {
      console.log('No custom indexes in "messages" collection');
    }

    console.log('Index dropping process completed');
  } catch (error) {
    console.error('Error dropping indexes:', error.message);
    if (error.message.includes('ETIMEOUT') || error.name === 'MongoNetworkError') {
      console.error('Network issue detected. Check your connection or MongoDB Atlas status.');
    }
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

dropIndexes();