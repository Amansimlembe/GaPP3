import { openDB } from 'idb';

const DB_NAME = 'ChatDB';
const MESSAGE_STORE_NAME = 'messages';
const PENDING_STORE_NAME = 'pendingMessages'; // New store for pending messages
const VERSION = 4; // Increment version to accommodate new store

const dbPromise = openDB(DB_NAME, VERSION, {
  upgrade(db, oldVersion, newVersion) {
    console.log(`Upgrading database from version ${oldVersion} to ${newVersion}`);

    // Handle messages store
    if (db.objectStoreNames.contains(MESSAGE_STORE_NAME)) {
      db.deleteObjectStore(MESSAGE_STORE_NAME);
    }
    const messageStore = db.createObjectStore(MESSAGE_STORE_NAME, { keyPath: '_id' });
    messageStore.createIndex('byRecipientId', 'recipientId', { multiEntry: false });
    messageStore.createIndex('byCreatedAt', 'createdAt', { multiEntry: false });

    // Handle pendingMessages store
    if (!db.objectStoreNames.contains(PENDING_STORE_NAME)) {
      // Only create if it doesn’t exist to avoid errors on upgrades from earlier versions
      const pendingStore = db.createObjectStore(PENDING_STORE_NAME, { keyPath: 'tempId' });
      pendingStore.createIndex('byRecipientId', 'recipientId', { multiEntry: false });
    }
  },
  blocked() {
    console.error('Database upgrade blocked by an open connection');
  },
  blocking() {
    console.warn('Current connection is blocking a database upgrade');
  },
});

export const saveMessages = async (messages) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(MESSAGE_STORE_NAME);

    await Promise.all(messages.map((msg) => store.put(msg)));
    await tx.done;
    console.log(`Saved ${messages.length} messages to IndexedDB`);
  } catch (error) {
    console.error('Error saving messages to IndexedDB:', error);
    throw error;
  }
};

export const getMessages = async (recipientId = null) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(MESSAGE_STORE_NAME, 'readonly');
    const store = tx.objectStore(MESSAGE_STORE_NAME);

    if (recipientId) {
      const index = store.index('byRecipientId');
      const messages = await index.getAll(recipientId);
      return messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    }

    const allMessages = await store.getAll();
    return allMessages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } catch (error) {
    console.error('Error retrieving messages from IndexedDB:', error);
    return [];
  }
};

export const deleteMessage = async (messageId) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(MESSAGE_STORE_NAME);

    await store.delete(messageId);
    await tx.done;
    console.log(`Deleted message ${messageId} from IndexedDB`);
  } catch (error) {
    console.error('Error deleting message from IndexedDB:', error);
    throw error;
  }
};

export const clearOldMessages = async (daysToKeep = 30) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(MESSAGE_STORE_NAME);

    if (!store.indexNames.contains('byCreatedAt')) {
      console.warn('byCreatedAt index not found; falling back to full scan');
      const allMessages = await store.getAll();
      const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
      const oldMessages = allMessages.filter((msg) => new Date(msg.createdAt) < cutoff);
      await Promise.all(oldMessages.map((msg) => store.delete(msg._id)));
      console.log(`Cleared ${oldMessages.length} old messages from IndexedDB (fallback)`);
      return oldMessages.length;
    }

    const index = store.index('byCreatedAt');
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    let count = 0;
    const cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff));
    while (cursor) {
      await cursor.delete();
      count++;
      await cursor.continue();
    }

    await tx.done;
    console.log(`Cleared ${count} old messages from IndexedDB`);
    return count;
  } catch (error) {
    console.error('Error clearing old messages from IndexedDB:', error);
    return 0;
  }
};

export const clearAllMessages = async () => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(MESSAGE_STORE_NAME);

    await store.clear();
    await tx.done;
    console.log('Cleared all messages from IndexedDB');
  } catch (error) {
    console.error('Error clearing all messages from IndexedDB:', error);
    throw error;
  }
};

export const checkIndexes = async () => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(MESSAGE_STORE_NAME, 'readonly');
    const store = tx.objectStore(MESSAGE_STORE_NAME);
    const indexes = Array.from(store.indexNames);
    console.log('Indexes available:', indexes);
    return indexes;
  } catch (error) {
    console.error('Error checking indexes in IndexedDB:', error);
    return [];
  }
};

// New functions for pending messages
export const savePendingMessages = async (pendingMessages) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(PENDING_STORE_NAME, 'readwrite');
    const store = tx.objectStore(PENDING_STORE_NAME);

    // Clear existing pending messages and save new ones
    await store.clear();
    await Promise.all(pendingMessages.map((msg) => store.put(msg)));
    await tx.done;
    console.log(`Saved ${pendingMessages.length} pending messages to IndexedDB`);
  } catch (error) {
    console.error('Error saving pending messages to IndexedDB:', error);
    throw error;
  }
};

export const loadPendingMessages = async () => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(PENDING_STORE_NAME, 'readonly');
    const store = tx.objectStore(PENDING_STORE_NAME);

    const pendingMessages = await store.getAll();
    console.log(`Loaded ${pendingMessages.length} pending messages from IndexedDB`);
    return pendingMessages;
  } catch (error) {
    console.error('Error loading pending messages from IndexedDB:', error);
    return [];
  }
};

export const clearPendingMessages = async () => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(PENDING_STORE_NAME, 'readwrite');
    const store = tx.objectStore(PENDING_STORE_NAME);

    await store.clear();
    await tx.done;
    console.log('Cleared all pending messages from IndexedDB');
  } catch (error) {
    console.error('Error clearing pending messages from IndexedDB:', error);
    throw error;
  }
};

export default dbPromise;