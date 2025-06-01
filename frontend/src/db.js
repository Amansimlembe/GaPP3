import { openDB } from 'idb';

const DB_NAME = 'ChatDB';
const MESSAGE_STORE_NAME = 'messages';
const PENDING_STORE_NAME = 'pendingMessages';
const VERSION = 9; // Incremented to 9 to force clean upgrade

// Singleton to manage single openDB instance
let dbInstance = null;

const getDB = async () => {
  if (dbInstance) {
    try {
      // Verify connection is still valid
      await dbInstance.transaction(MESSAGE_STORE_NAME).objectStore(MESSAGE_STORE_NAME).getAll();
      return dbInstance;
    } catch (err) {
      console.warn('Existing DB connection invalid, reopening:', err.message);
      dbInstance.close();
      dbInstance = null;
    }
  }

  dbInstance = await openDB(DB_NAME, VERSION, {
    upgrade(db, oldVersion, newVersion, transaction) {
      console.log(`Upgrading database from version ${oldVersion} to ${newVersion}`);

      try {
        // Create 'messages' store if it doesn't exist
        if (!db.objectStoreNames.contains(MESSAGE_STORE_NAME)) {
          const messageStore = db.createObjectStore(MESSAGE_STORE_NAME, { keyPath: '_id' });
          messageStore.createIndex('byRecipientId', 'recipientId');
          messageStore.createIndex('byCreatedAt', 'createdAt');
          messageStore.createIndex('byClientMessageId', 'clientMessageId', { unique: false });
          messageStore.createIndex('byRecipientAndTime', ['recipientId', 'createdAt']);
          messageStore.createIndex('byStatus', 'status', { unique: false });
        } else {
          // Update existing 'messages' store safely
          const messageStore = transaction.objectStore(MESSAGE_STORE_NAME);
          if (!messageStore.indexNames.contains('byStatus') && oldVersion < 8) {
            messageStore.createIndex('byStatus', 'status', { unique: false });
          }
        }

        // Create 'pendingMessages' store if it doesn't exist
        if (!db.objectStoreNames.contains(PENDING_STORE_NAME)) {
          const pendingStore = db.createObjectStore(PENDING_STORE_NAME, { keyPath: 'tempId' });
          pendingStore.createIndex('byRecipientId', 'recipientId');
        }
      } catch (err) {
        console.error('Error in upgradeneeded handler:', err);
        throw err; // Let transaction abort naturally
      }
    },
    blocked(currentVersion, blockedVersion, event) {
      console.error(`Database upgrade blocked by open connection (current: ${currentVersion}, blocked: ${blockedVersion})`);
      // Attempt to close all connections
      dbInstance?.close();
      // Notify user to close other tabs
      alert('Please close other tabs or instances of the app to allow database upgrade.');
    },
    blocking(currentVersion, blockedVersion, event) {
      console.warn(`Current connection (v${currentVersion}) is blocking upgrade to v${blockedVersion}`);
      dbInstance?.close();
    },
    terminated() {
      console.warn('Database connection terminated unexpectedly');
      dbInstance = null;
    },
  });

  return dbInstance;
};

const withRetry = async (operation, maxRetries = 3) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      attempt++;
      console.error(`Database operation failed, attempt ${attempt}:`, error.message);
      if (error.name === 'AbortError' && attempt === 1) {
        console.warn('AbortError detected, closing connection and retrying');
        dbInstance?.close();
        dbInstance = null;
      }
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
};

// Utility to clear the database for debugging or recovery
export const clearDatabase = async () => {
  try {
    dbInstance?.close();
    await indexedDB.deleteDatabase(DB_NAME);
    dbInstance = null;
    console.log('IndexedDB database cleared');
  } catch (error) {
    console.error('Error clearing IndexedDB database:', error);
  }
};

export const saveMessages = async (messages) => {
  try {
    return await withRetry(async () => {
      const db = await getDB();
      const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(MESSAGE_STORE_NAME);
      await Promise.all(
        messages.map((msg) =>
          store.put({
            ...msg,
            _id: msg._id || `${msg.clientMessageId}`,
            content: msg.content || '',
            plaintextContent: msg.plaintextContent || '',
            status: msg.status || 'pending',
            contentType: msg.contentType || 'text',
            caption: msg.caption || '',
            createdAt: msg.createdAt || new Date().toISOString(),
            senderVirtualNumber: msg.senderVirtualNumber || '',
            senderUsername: msg.senderUsername || '',
            senderPhoto: msg.senderPhoto || 'https://placehold.co/40x40',
            replyTo: msg.replyTo || undefined,
            originalFilename: msg.originalFilename || undefined,
            clientMessageId: msg.clientMessageId || `${msg.senderId}-${Date.now()}`,
          })
        )
      );
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
      const db = await getDB();
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
      const db = await getDB();
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
      const db = await getDB();
      const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(MESSAGE_STORE_NAME);
      const index = store.index('byCreatedAt');
      const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
      let count = 0;
      const cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff.toISOString()));
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
      const db = await getDB();
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
      const db = await getDB();
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
      const db = await getDB();
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

export default getDB;