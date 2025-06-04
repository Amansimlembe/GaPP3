import { openDB } from 'idb';

const DB_NAME = 'MyChatDB';
const MESSAGE_STORE = 'messages';
const PENDING_STORE = 'pendingMessages';
const VERSION = 11;

let db;

const getDb = async () => {
  if (db) {
    try {
      await db.transaction(MESSAGE_STORE).objectStore(MESSAGE_STORE).count();
      return db;
    } catch (error) {
      console.warn('DB connection invalid:', error);
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
      }

      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        const pendingStore = db.createObjectStore(PENDING_STORE, { keyPath: 'tempId' });
        pendingStore.createIndex('byRecipientId', 'recipientId');
      }
    },
    blocked(db) {
      console.error('DB upgrade blocked.');
      db?.close();
      alert('Close other tabs to allow DB upgrade.');
    },
    blocking() {
      console.warn('Blocking upgrade...');
      db?.close();
    },
    terminated() {
      console.warn('DB connection terminated');
      db = null;
    },
  });

  return db;
};
