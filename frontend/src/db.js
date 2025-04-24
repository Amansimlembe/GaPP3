import { openDB } from 'idb';

const DB_NAME = 'ChatDB';
const MESSAGE_STORE_NAME = 'messages';
const PENDING_STORE_NAME = 'pendingMessages';
const VERSION = 7;

const dbPromise = openDB(DB_NAME, VERSION, {
  upgrade(db, oldVersion, newVersion) {
    console.log(`Upgrading database from version ${oldVersion} to ${newVersion}`);
    if (db.objectStoreNames.contains(MESSAGE_STORE_NAME)) {
      db.deleteObjectStore(MESSAGE_STORE_NAME);
    }
    const messageStore = db.createObjectStore(MESSAGE_STORE_NAME, { keyPath: '_id' });
    messageStore.createIndex('byRecipientId', 'recipientId');
    messageStore.createIndex('byCreatedAt', 'createdAt');
    messageStore.createIndex('byClientMessageId', 'clientMessageId', { unique: false });
    messageStore.createIndex('byRecipientAndTime', ['recipientId', 'createdAt']);

    if (db.objectStoreNames.contains(PENDING_STORE_NAME)) {
      db.deleteObjectStore(PENDING_STORE_NAME);
    }
    const pendingStore = db.createObjectStore(PENDING_STORE_NAME, { keyPath: 'tempId' });
    pendingStore.createIndex('byRecipientId', 'recipientId');
  },
  blocked() {
    console.error('Database upgrade blocked by an open connection');
    indexedDB.deleteDatabase(DB_NAME); // Clear database to resolve blocking issues
  },
  blocking() {
    console.warn('Current connection is blocking a database upgrade');
    dbPromise.then((db) => db.close());
  },
});

const withRetry = async (operation, maxRetries = 3) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      attempt++;
      console.error(`Database operation failed, attempt ${attempt}:`, error);
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
};

export const saveMessages = async (messages) => {
  try {
    return await withRetry(async () => {
      const db = await dbPromise;
      const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(MESSAGE_STORE_NAME);
      await Promise.all(messages.map((msg) => store.put({
        ...msg,
        plaintextContent: msg.plaintextContent || '',
        senderVirtualNumber: msg.senderVirtualNumber || '',
        senderUsername: msg.senderUsername || '',
        senderPhoto: msg.senderPhoto || 'https://placehold.co/40x40',
      })));
      await tx.done;
    });
  } catch (error) {
    console.error('Error saving messages to IndexedDB:', error);
    throw error;
  }
};

export const getMessages = async (recipientId = null) => {
  try {
    return await withRetry(async () => {
      const db = await dbPromise;
      const tx = db.transaction(MESSAGE_STORE_NAME, 'readonly');
      const store = tx.objectStore(MESSAGE_STORE_NAME);
      if (recipientId) {
        const index = store.index('byRecipientAndTime');
        const messages = await index.getAll([recipientId]);
        return messages;
      }
      const allMessages = await store.getAll();
      return allMessages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    });
  } catch (error) {
    console.error('Error retrieving messages from IndexedDB:', error);
    return [];
  }
};

export const deleteMessage = async (messageId) => {
  try {
    return await withRetry(async () => {
      const db = await dbPromise;
      const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(MESSAGE_STORE_NAME);
      await store.delete(messageId);
      await tx.done;
    });
  } catch (error) {
    console.error('Error deleting message from IndexedDB:', error);
    throw error;
  }
};

export const clearOldMessages = async (daysToKeep = 30) => {
  try {
    return await withRetry(async () => {
      const db = await dbPromise;
      const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(MESSAGE_STORE_NAME);
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
      return count;
    });
  } catch (error) {
    console.error('Error clearing old messages from IndexedDB:', error);
    return 0;
  }
};

export const savePendingMessages = async (pendingMessages) => {
  try {
    return await withRetry(async () => {
      const db = await dbPromise;
      const tx = db.transaction(PENDING_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PENDING_STORE_NAME);
      await store.clear();
      await Promise.all(
        pendingMessages.map((msg) => {
          if (!msg.tempId || typeof msg.tempId !== 'string') {
            throw new Error('Invalid tempId in pending message');
          }
          return store.put({
            ...msg,
            plaintextContent: msg.plaintextContent || '',
            senderVirtualNumber: msg.senderVirtualNumber || '',
            senderUsername: msg.senderUsername || '',
            senderPhoto: msg.senderPhoto || 'https://placehold.co/40x40',
          });
        })
      );
      await tx.done;
    });
  } catch (error) {
    console.error('Error saving pending messages to IndexedDB:', error);
    throw error;
  }
};

export const loadPendingMessages = async () => {
  try {
    return await withRetry(async () => {
      const db = await dbPromise;
      const tx = db.transaction(PENDING_STORE_NAME, 'readonly');
      const store = tx.objectStore(PENDING_STORE_NAME);
      return await store.getAll();
    });
  } catch (error) {
    console.error('Error loading pending messages from IndexedDB:', error);
    return [];
  }
};

export const clearPendingMessages = async () => {
  try {
    return await withRetry(async () => {
      const db = await dbPromise;
      const tx = db.transaction(PENDING_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PENDING_STORE_NAME);
      await store.clear();
      await tx.done;
    });
  } catch (error) {
    console.error('Error clearing pending messages from IndexedDB:', error);
    throw error;
  }
};

export default dbPromise;