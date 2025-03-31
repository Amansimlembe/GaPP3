import { openDB } from 'idb';

const DB_NAME = 'ChatDB';
const STORE_NAME = 'messages';
const VERSION = 2;

const dbPromise = openDB(DB_NAME, VERSION, {
  upgrade(db, oldVersion, newVersion, transaction) {
    if (oldVersion < 1) {
      db.createObjectStore(STORE_NAME, { keyPath: '_id' });
    }
    if (oldVersion < 2) {
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
    throw error;
  }
};

export const getMessages = async (recipientId = null) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

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

export const clearOldMessages = async (daysToKeep = 30) => {
  try {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('byCreatedAt');
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff));
    let count = 0;
    while (cursor) {
      await cursor.delete();
      count++;
      cursor = await cursor.continue();
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