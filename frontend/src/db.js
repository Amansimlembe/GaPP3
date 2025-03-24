 import { openDB } from 'idb';

const dbPromise = openDB('ChatDB', 1, {
  upgrade(db) {
    db.createObjectStore('messages', { keyPath: '_id' });
  }
});

export const saveMessages = async (messages) => {
  const db = await dbPromise;
  const tx = db.transaction('messages', 'readwrite');
  messages.forEach(msg => tx.store.put(msg));
  await tx.done;
};

export const getMessages = async () => {
  const db = await dbPromise;
  return db.getAll('messages');
};