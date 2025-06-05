import { openDB } from 'idb';

const DB_NAME = 'MyChatDB';
const MESSAGE_STORE = 'messages';
const PENDING_STORE = 'pendingMessages';
const VERSION = 12; // Incremented to ensure clean migration

let db = null;

const getDb = async () => {
  if (db) {
    try {
      await db.transaction(MESSAGE_STORE).objectStore(MESSAGE_STORE).count();
      return db;
    } catch (error) {
      console.warn('DB connection invalid:', error.message);
      db.close();
      db = null;
    }
  }

  db = await openDB(DB_NAME, VERSION, {
    upgrade(db, oldVersion, newVersion) {
      console.log(`Upgrading DB from v${oldVersion} to v${newVersion}`);
      if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
        const messageStore = db.createObjectStore(MESSAGE_STORE, { keyPath: '_id' });
        messageStore.createIndex('byRecipientId', 'recipientId');
        messageStore.createIndex('byCreatedAt', 'createdAt');
        messageStore.createIndex('byClientMessageId', 'clientMessageId', { unique: true });
        messageStore.createIndex('byRecipientAndTime', ['recipientId', 'createdAt']);
        messageStore.createIndex('byStatus', 'status');
      } else {
        const tx = db.transaction([MESSAGE_STORE], 'readwrite');
        const messageStore = tx.objectStore(MESSAGE_STORE);
        if (!messageStore.indexNames.contains('byClientMessageId')) {
          messageStore.createIndex('byClientMessageId', 'clientMessageId', { unique: true });
        }
        if (!messageStore.indexNames.contains('byStatus')) {
          messageStore.createIndex('byStatus', 'status', { unique: false });
        }
      }

      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        const pendingStore = db.createObjectStore(PENDING_STORE, { keyPath: 'tempId' });
        pendingStore.createIndex('byRecipientId', 'recipientId');
      }
    },
    blocked(currentVersion, blockedVersion) {
      console.error(`DB upgrade blocked: v${currentVersion}, blocked v${blockedVersion}`);
      db?.close();
      alert('Close other tabs to allow DB upgrade.');
    },
    blocking(currentVersion, blockedVersion) {
      console.warn(`Blocking upgrade to v${blockedVersion}`);
      db?.close();
    },
    terminated() {
      console.warn('DB connection terminated');
      db = null;
    },
  });

  return db;
};

const withRetry = async (operation, maxRetries = 3) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      attempt++;
      console.error(`DB operation failed, attempt ${attempt}:`, error.message);
      if (error.name === 'VersionError') {
        db?.close();
        db = null;
        throw error;
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
    db?.close();
    await indexedDB.deleteDatabase(DB_NAME);
    db = null;
    console.log('Database cleared');
  } catch (error) {
    console.error('Error clearing DB:', error.message);
    throw error;
  }
};



export const saveMessages = async (messages) => {
  if (!Array.isArray(messages) || !messages.length) {
    console.warn('No messages to save');
    return;
  }

  try {
    await withRetry(async () => {
      const db = await getDb();
      const tx = db.transaction(MESSAGE_STORE, 'readwrite');
      const store = tx.objectStore(MESSAGE_STORE);

      await Promise.all(
        messages.map((msg) => {
          if (!msg._id || !msg.clientMessageId || !msg.recipientId || !msg.senderId || !isValidObjectId(msg.recipientId) || !isValidObjectId(msg.senderId)) {
            console.warn('Invalid message skipped:', msg);
            return Promise.resolve();
          }
          return store.put({
            ...msg,
            _id: msg._id,
            clientMessageId: msg.clientMessageId,
            content: msg.content || '',
            plaintextContent: msg.plaintextContent || '',
            status: ['pending', 'sent', 'delivered', 'read'].includes(msg.status) ? msg.status : 'pending',
            contentType: ['text', 'image', 'video', 'audio', 'document'].includes(msg.contentType) ? msg.contentType : 'text',
            caption: msg.caption || '',
            createdAt: msg.createdAt || new Date().toISOString(),
            senderVirtualNumber: msg.senderVirtualNumber || '',
            senderUsername: msg.senderUsername || '',
            senderPhoto: msg.senderPhoto || 'https://placehold.co/40x40',
            replyTo: msg.replyTo || null,
            originalFilename: msg.originalFilename || undefined,
            recipientId: msg.recipientId,
            senderId: msg.senderId,
          });
        })
      );

      await tx.done;
      console.log(`Saved ${messages.length} messages to IndexedDB`);
    });
  } catch (error) {
    console.error('Error saving messages to IndexedDB:', error.message);
    throw error;
  }
};



export const getMessages = async (recipientId) => {
  try {
    return await withRetry(async () => {
      const db = await getDb();
      const tx = db.transaction(MESSAGE_STORE, 'readonly');
      const store = tx.objectStore(MESSAGE_STORE);

      let messages;
      if (recipientId) {
        const index = store.index('byRecipientAndTime');
        messages = await index.getAll([recipientId]);
      } else {
        messages = await store.getAll();
      }

      console.log(`Retrieved ${messages.length} messages for recipientId: ${recipientId || 'all'}`);
      return messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    });
  } catch (error) {
    console.error('Error retrieving messages from IndexedDB:', error.message);
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
      const db = await getDb();
      const tx = db.transaction(MESSAGE_STORE, 'readwrite');
      const store = tx.objectStore(MESSAGE_STORE);
      await store.delete(messageId);
      await tx.done;
      console.log(`Deleted message ${messageId} from IndexedDB`);
    });
  } catch (error) {
    console.error('Error deleting message from IndexedDB:', error.message);
    throw error;
  }
};

export const clearOldMessages = async (daysToKeep = 30) => {
  try {
    return await withRetry(async () => {
      const db = await getDb();
      const tx = db.transaction(MESSAGE_STORE, 'readwrite');
      const store = tx.objectStore(MESSAGE_STORE);
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
      console.log(`Cleared ${count} old messages from IndexedDB`);
      return count;
    });
  } catch (error) {
    console.error('Error clearing old messages from IndexedDB:', error.message);
    throw error;
  }
};

export const savePendingMessages = async (pendingMessages) => {
  if (!Array.isArray(pendingMessages) || !pendingMessages.length) {
    console.warn('No pending messages to save');
    return;
  }

  try {
    await withRetry(async () => {
      const db = await getDb();
      const tx = db.transaction(PENDING_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_STORE);

      await Promise.all(
        pendingMessages.map((msg) => {
          if (!msg.tempId || typeof msg.tempId !== 'string' || !msg.messageData) {
            console.warn('Invalid pending message:', msg);
            throw new Error('Invalid pending message');
          }
          return store.put({
            tempId: msg.tempId,
            recipientId: msg.recipientId || '',
            messageData: {
              ...msg.messageData,
              content: msg.messageData.content || '',
              plaintextContent: msg.messageData.plaintextContent || '',
              contentType: ['text', 'image', 'video', 'audio', 'document'].includes(msg.messageData.contentType)
                ? msg.messageData.contentType
                : 'text',
              clientMessageId: msg.messageData.clientMessageId || msg.tempId,
              senderId: msg.messageData.senderId || '',
              recipientId: msg.messageData.recipientId || '',
              senderVirtualNumber: msg.messageData.senderVirtualNumber || '',
              senderUsername: msg.messageData.senderUsername || '',
              senderPhoto: msg.messageData.senderPhoto || 'https://placehold.co/40x40',
              replyTo: msg.messageData.replyTo || undefined,
            },
          });
        })
      );

      await tx.done;
      console.log(`Saved ${pendingMessages.length} pending messages to IndexedDB`);
    });
  } catch (error) {
    console.error('Error saving pending messages to IndexedDB:', error.message);
    throw error;
  }
};

export const loadPendingMessages = async () => {
  try {
    return await withRetry(async () => {
      const db = await getDb();
      const tx = db.transaction(PENDING_STORE, 'readonly');
      const store = tx.objectStore(PENDING_STORE);
      const messages = await store.getAll();
      const validMessages = messages.filter((msg) => msg.tempId && msg.recipientId && msg.messageData);
      console.log(`Loaded ${validMessages.length} pending messages from IndexedDB`);
      return validMessages;
    });
  } catch (error) {
    console.error('Error loading pending messages from IndexedDB:', error.message);
    return [];
  }
};



export const clearPendingMessages = async (tempIds = []) => {
  try {
    await withRetry(async () => {
      const db = await getDb();
      const tx = db.transaction(PENDING_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_STORE);
      if (tempIds.length) {
        await Promise.all(tempIds.map((tempId) => store.delete(tempId)));
        console.log(`Cleared ${tempIds.length} specific pending messages from IndexedDB`);
      } else {
        await store.clear();
        console.log('Cleared all pending messages from IndexedDB');
      }
      await tx.done;
    });
  } catch (error) {
    console.error('Error clearing pending messages from IndexedDB:', error.message);
    throw error;
  }
};





export default getDb;