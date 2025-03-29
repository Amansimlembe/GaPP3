import { openDB } from 'idb';

const dbPromise = openDB('ChatDB', 2, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      db.createObjectStore('messages', { keyPath: '_id' });
    }
    if (oldVersion < 2) {
      if (db.objectStoreNames.contains('messages')) {
        db.deleteObjectStore('messages');
      }
      const messageStore = db.createObjectStore('messages', { keyPath: '_id' });
      messageStore.createIndex('byRecipientId', 'recipientId');
    }
  },
});

export const saveMessages = async (messages) => {
  const db = await dbPromise;
  const tx = db.transaction('messages', 'readwrite');
  const store = tx.objectStore('messages');
  await Promise.all(messages.map((msg) => store.put(msg)));
  await tx.done;
};

export const getMessages = async (recipientId = null) => {
  const db = await dbPromise;
  const tx = db.transaction('messages', 'readonly');
  const store = tx.objectStore('messages');

  if (recipientId) {
    const index = store.index('byRecipientId');
    return await index.getAll(recipientId);
  }
  return await store.getAll();
};

export const clearOldMessages = async (daysToKeep = 30) => {
  const db = await dbPromise;
  const tx = db.transaction('messages', 'readwrite');
  const store = tx.objectStore('messages');
  const allMessages = await store.getAll();
  const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

  const deletes = allMessages
    .filter((msg) => new Date(msg.createdAt) < cutoff)
    .map((msg) => store.delete(msg._id));
  await Promise.all(deletes);
  await tx.done;
};