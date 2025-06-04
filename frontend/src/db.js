import { openDB } from 'idb';

const DB_NAME = 'ChatDB';
const MESSAGE_STORE_NAME = 'messages';
const PENDING_STORE_NAME = 'pendingMessages';
const VERSION = 10; // Incremented to force clean upgrade

let dbInstance = null;

const getDB = async () => {
  if (dbInstance) {
    try {
      await dbInstance.transaction(MESSAGE_STORE_NAME).objectStore(MESSAGE_STORE_NAME).count();
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
        if (!db.objectStoreNames.contains(MESSAGE_STORE_NAME)) {
          const messageStore = db.createObjectStore(MESSAGE_STORE_NAME, { keyPath: '_id' });
          messageStore.createIndex('byRecipientId', 'recipientId');
          messageStore.createIndex('byCreatedAt', 'createdAt');
          messageStore.createIndex('byClientMessageId', 'clientMessageId', { unique: false });
          messageStore.createIndex('byRecipientAndTime', ['recipientId', 'createdAt']);
          messageStore.createIndex('byStatus', 'status', { unique: false });
        } else {
          const messageStore = transaction.objectStore(MESSAGE_STORE_NAME);
          if (!messageStore.indexNames.contains('byStatus')) {
            messageStore.createIndex('byStatus', 'status', { unique: false });
          }
        }

        if (!db.objectStoreNames.contains(PENDING_STORE_NAME)) {
          const pendingStore = db.createObjectStore(PENDING_STORE_NAME, { keyPath: 'tempId' });
          pendingStore.createIndex('byRecipientId', 'recipientId');
        }
      } catch (err) {
        console.error('Error in upgradeneeded handler:', err);
        throw err;
      }
    },
    blocked(currentVersion, blockedVersion) {
      console.error(`Database upgrade blocked: current v${currentVersion}, blocked v${blockedVersion}`);
      dbInstance?.close();
      alert('Please close other tabs to allow database upgrade.');
    },
    blocking(currentVersion, blockedVersion) {
      console.warn(`Current connection v${currentVersion} blocking upgrade to v${blockedVersion}`);
      dbInstance?.close();
    },
    terminated() {
      console.warn('Database connection terminated');
      dbInstance = null;
    },
  });

  return dbInstance;
};

const withRetry = async (operation, maxRetries = 3) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const result = await operation();
      return result;
    } catch (error) {
      attempt++;
      console.error(`Database operation failed, attempt ${attempt}:`, error.message);
      if (error.name === 'AbortError' || error.name === 'VersionError') {
        dbInstance?.close();
        dbInstance = null;
      }
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
};

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
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    console.warn('No valid messages to save');
    return;
  }

  try {
    await withRetry(async () => {
      const db = await getDB();
      const tx = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(MESSAGE_STORE_NAME);

      await Promise.all(messages.map((msg) => {
        if (!msg._id && !msg.clientMessageId) {
          throw new Error('Message missing _id or clientMessageId');
        }
        return store.put({
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
          clientMessageId: msg.clientMessageId || `${msg.senderId || 'unknown'}-${Date.now()}`,
          recipientId: msg.recipientId || '',
          senderId: msg.senderId || '',
        });
      }));

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
        return messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
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
  if (!messageId) {
    console.warn('No messageId provided for deletion');
    return;
  }

  try {
    await withRetry(async () => {
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

      let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff.toISOString()));
      while (cursor) {
        await cursor.delete();
        count++;
        cursor = await cursor.continue();
      }

      await tx.done;
      console.log(`Cleared ${count} old messages`);
      return count;
    });
  } catch (error) {
    console.error('Error clearing old messages from IndexedDB:', error);
    return 0;
  }
};

export const savePendingMessages = async (pendingMessages) => {
  if (!pendingMessages || !Array.isArray(pendingMessages)) {
    console.warn('No valid pending messages to save');
    return;
  }

  try {
    await withRetry(async () => {
      const db = await getDB();
      const tx = db.transaction(PENDING_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PENDING_STORE_NAME);
      await store.clear();

      await Promise.all(pendingMessages.map((msg) => {
        if (!msg.tempId || typeof msg.tempId !== 'string') {
          throw new Error('Invalid tempId in pending message');
        }
        return store.put({
          ...msg,
          tempId: msg.tempId,
          recipientId: msg.recipientId || msg.messageData?.recipientId || '',
          messageData: {
            ...msg.messageData,
            content: msg.messageData?.content || '',
            plaintextContent: msg.messageData?.plaintextContent || '',
            contentType: msg.messageData?.contentType || 'text',
            clientMessageId: msg.messageData?.clientMessageId || msg.tempId,
            senderId: msg.messageData?.senderId || '',
            recipientId: msg.messageData?.recipientId || '',
            senderVirtualNumber: msg.messageData?.senderVirtualNumber || '',
            senderUsername: msg.messageData?.senderUsername || '',
            senderPhoto: msg.messageData?.senderPhoto || 'https://placehold.co/40x40',
            replyTo: msg.messageData?.replyTo || undefined,
          },
        });
      }));

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
      const messages = await store.getAll();
      return messages.filter((msg) => msg.tempId && msg.recipientId && msg.messageData);
    });
  } catch (error) {
    console.error('Error loading pending messages from IndexedDB:', error);
    return [];
  }
};

export const clearPendingMessages = async () => {
  try {
    await withRetry(async () => {
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