import { openDB } from 'idb';

const DB_NAME = 'ChatDB';
const STORE_NAME = 'messages';
const VERSION = 2;

// Open or create the IndexedDB database
const dbPromise = openDB(DB_NAME, VERSION, {
  upgrade(db, oldVersion, newVersion, transaction) {
    if (oldVersion < 1) {
      // Initial setup for version 1
      db.createObjectStore(STORE_NAME, { keyPath: '_id' });
    }
    if (oldVersion < 2) {
      // Upgrade to version 2: recreate store with improved indexes
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      const messageStore = db.createObjectStore(STORE_NAME, { keyPath: '_id' });
      messageStore.createIndex('byRecipientId', 'recipientId', { multiEntry: false });
      messageStore.createIndex('byCreatedAt', 'createdAt', { multiEntry: false });
    }
  },
  blocked() {
    console.error('Database upgrade blocked by an open connection');
  },
  blocking() {
    console.warn('Current connection is blocking a database upgrade');
  },
});

// Save messages to IndexedDB
export const saveMessages = async (messages) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    await Promise.all(messages.map((msg) => store.put(msg)));
    await tx.done;
    console.log(`Saved ${messages.length} messages to IndexedDB`);
  } catch (error) {
    console.error('Error saving messages to IndexedDB:', error);
    throw error; // Re-throw to allow caller handling
  }
};

// Retrieve messages from IndexedDB
export const getMessages = async (recipientId = null) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    if (recipientId) {
      const index = store.index('byRecipientId');
      const messages = await index.getAll(recipientId);
      return messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // Ensure chronological order
    }

    const allMessages = await store.getAll();
    return allMessages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } catch (error) {
    console.error('Error retrieving messages from IndexedDB:', error);
    return [];
  }
};

// Delete a specific message by ID
export const deleteMessage = async (messageId) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    await store.delete(messageId);
    await tx.done;
    console.log(`Deleted message ${messageId} from IndexedDB`);
  } catch (error) {
    console.error('Error deleting message from IndexedDB:', error);
    throw error;
  }
};

// Clear messages older than a specified number of days
export const clearOldMessages = async (daysToKeep = 30) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('byCreatedAt');
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const allMessages = await index.getAll();
    const deletes = allMessages
      .filter((msg) => new Date(msg.createdAt) < cutoff)
      .map((msg) => store.delete(msg._id));

    await Promise.all(deletes);
    await tx.done;
    console.log(`Cleared ${deletes.length} old messages from IndexedDB`);
    return deletes.length;
  } catch (error) {
    console.error('Error clearing old messages from IndexedDB:', error);
    return 0;
  }
};

// Clear all messages (for logout or reset)
export const clearAllMessages = async () => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    await store.clear();
    await tx.done;
    console.log('Cleared all messages from IndexedDB');
  } catch (error) {
    console.error('Error clearing all messages from IndexedDB:', error);
    throw error;
  }
};

export default dbPromise;