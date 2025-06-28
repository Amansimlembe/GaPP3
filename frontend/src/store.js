import { configureStore, createSlice } from '@reduxjs/toolkit';
import { openDB } from 'idb';
import axios from 'axios';

// Constants
const DB_NAME = 'chatApp';
const STORE_NAME = 'reduxState';
const VERSION = 3;
const MAX_MESSAGES_PER_CHAT = 100;
const MESSAGE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const PERSISTENCE_DEBOUNCE_MS = 300;
const CACHE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const BASE_URL = 'https://gapp-6yc3.onrender.com';

// ObjectId validation
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

// Check IndexedDB support
const isIndexedDBSupported = () => {
  if (!window.indexedDB) {
    console.warn('IndexedDB not supported in this environment');
    return false;
  }
  return true;
};

// Initialize IndexedDB with fallback
const initDB = async () => {
  if (!isIndexedDBSupported()) {
    console.warn('Falling back to in-memory storage due to lack of IndexedDB support');
    return null;
  }

  try {
    const db = await openDB(DB_NAME, VERSION, {
      upgrade(db, oldVersion, newVersion) {
        if (oldVersion < 1) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
        if (oldVersion < 3) {
          console.log('Upgraded IndexedDB from version', oldVersion, 'to', newVersion);
        }
      },
      blocked() {
        console.warn('IndexedDB blocked: Another instance is holding an open connection');
      },
      blocking() {
        console.warn('IndexedDB blocking: Closing connection to allow upgrade');
        db.close();
      },
      terminated() {
        console.warn('IndexedDB connection terminated unexpectedly');
      },
    });
    return db;
  } catch (error) {
    console.error('Failed to initialize IndexedDB:', error.message);
    await logClientError('IndexedDB initialization failed', error);
    try {
      await indexedDB.deleteDatabase(DB_NAME);
      console.log('Cleared corrupted IndexedDB database');
      const db = await openDB(DB_NAME, VERSION, {
        upgrade(db, oldVersion, newVersion) {
          if (oldVersion < 1) {
            db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          }
          if (oldVersion < 3) {
            console.log('Upgraded IndexedDB from version', oldVersion, 'to', newVersion);
          }
        },
      });
      return db;
    } catch (clearError) {
      console.error('Failed to clear and reinitialize IndexedDB:', clearError.message);
      await logClientError('Failed to clear IndexedDB', clearError);
      return null;
    }
  }
};

const errorLogTimestamps = new Map();

const logClientError = async (message, error, userId = null) => {
  const now = Date.now();
  const errorEntry = errorLogTimestamps.get(message) || { count: 0, timestamps: [] };
  errorEntry.timestamps = errorEntry.timestamps.filter((ts) => now - ts < 60 * 1000);
  if (errorEntry.count >= 1 || errorEntry.timestamps.length >= 1) {
    console.log(`Client error logging skipped for "${message}": rate limit reached`);
    return;
  }
  const isCritical = message.includes('Unauthorized') || message.includes('failed after max retries') || message.includes('IndexedDB');
  if (!isCritical) {
    return;
  }
  errorEntry.count += 1;
  errorEntry.timestamps.push(now);
  errorLogTimestamps.set(message, errorEntry);

  try {
    // Sanitize error details to prevent leaking sensitive data
    const sanitizedError = {
      message: error?.message || '',
      stack: error?.stack?.replace(/privateKey[^;]+|token[^;]+/gi, '[REDACTED]') || '',
    };
    await axios.post(
      `${BASE_URL}/social/log-error`,
      {
        error: message,
        stack: sanitizedError.stack,
        userId,
        route: window.location.pathname,
        timestamp: new Date().toISOString(),
        additionalInfo: JSON.stringify({
          navigatorOnline: navigator.onLine,
          currentPath: window.location.pathname,
          errorDetails: sanitizedError.message,
          browser: navigator.userAgent,
        }),
      },
      { timeout: 5000 }
    );
    console.log(`Critical error logged: ${message}`);
  } catch (err) {
    console.error('Failed to log critical error:', err.message);
  }
};

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    token: null,
    userId: null,
    role: null,
    photo: null,
    virtualNumber: null,
    username: null,
    privateKey: null,
  },
  reducers: {
    setAuth: (state, action) => {
      const { token, userId, role, photo, virtualNumber, username, privateKey } = action.payload;
      state.token = typeof token === 'string' && token ? token : null;
      state.userId = isValidObjectId(userId) ? userId : null;
      state.role = typeof role === 'number' || (typeof role === 'string' && !isNaN(role)) ? Number(role) : null;
      state.photo = typeof photo === 'string' ? photo : null;
      state.virtualNumber = typeof virtualNumber === 'string' ? virtualNumber : null;
      state.username = typeof username === 'string' ? username : null;
      state.privateKey = typeof privateKey === 'string' && privateKey ? privateKey : null;
    },
    clearAuth: (state) => {
      state.token = null;
      state.userId = null;
      state.role = null;
      state.photo = null;
      state.virtualNumber = null;
      state.username = null;
      state.privateKey = null;
    },
  },
});

const loadPersistedState = async () => {
  if (!isIndexedDBSupported()) {
    console.warn('No IndexedDB support, skipping persisted state load');
    return null;
  }

  try {
    const db = await initDB();
    if (!db) {
      console.warn('No database available, using initial state');
      return null;
    }
    const persistedState = await db.get(STORE_NAME, 'state');
    if (!persistedState?.value) {
      console.log('No persisted state found');
      return null;
    }

    const { messages, auth } = persistedState.value;
    if (!messages || !auth || !isValidObjectId(auth.userId)) {
      console.warn('loadPersistedState: Invalid persisted state structure', persistedState);
      return null;
    }

    const now = Date.now();
    const chats = Object.keys(messages.chats).reduce((acc, recipientId) => {
      if (isValidObjectId(recipientId)) {
        acc[recipientId] = messages.chats[recipientId]
          .filter(
            (msg) =>
              isValidObjectId(msg.senderId) &&
              isValidObjectId(msg.recipientId) &&
              (msg.senderId === auth.userId || msg.recipientId === auth.userId) &&
              ['sent', 'delivered', 'read', 'pending', 'failed'].includes(msg.status) &&
              now - new Date(msg.createdAt).getTime() <= MESSAGE_TTL
          )
          .map((msg) => ({
            _id: msg._id || msg.clientMessageId,
            clientMessageId: msg.clientMessageId || msg._id || `temp-${now}-${Math.random()}`,
            content: msg.content || '',
            contentType: msg.contentType || 'text',
            plaintextContent: msg.plaintextContent || '[Message not decrypted]',
            status: msg.status || 'pending',
            senderId: msg.senderId,
            recipientId: msg.recipientId,
            caption: msg.caption || undefined,
            replyTo: msg.replyTo && isValidObjectId(msg.replyTo) ? msg.replyTo : null,
            originalFilename: msg.originalFilename || undefined,
            senderVirtualNumber: msg.senderVirtualNumber || undefined,
            senderUsername: msg.senderUsername || undefined,
            senderPhoto: msg.senderPhoto || undefined,
            createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date().toISOString(),
            updatedAt: msg.updatedAt ? new Date(msg.updatedAt).toISOString() : undefined,
          }))
          .slice(-MAX_MESSAGES_PER_CHAT);
      }
      return acc;
    }, {});

    const chatMessageCount = Object.keys(chats).reduce((acc, recipientId) => {
      acc[recipientId] = chats[recipientId].length;
      return acc;
    }, {});

    const chatList = Array.isArray(messages.chatList)
      ? messages.chatList
          .filter(
            (contact) =>
              isValidObjectId(contact.id) &&
              contact.virtualNumber &&
              contact.ownerId === auth.userId // Ensure contacts belong to the user
          )
          .map((contact) => ({
            id: contact.id,
            username: contact.username || 'Unknown',
            virtualNumber: contact.virtualNumber || '',
            photo: contact.photo || 'https://placehold.co/40x40',
            status: contact.status || 'offline',
            lastSeen: contact.lastSeen ? new Date(contact.lastSeen).toISOString() : null,
            latestMessage: contact.latestMessage
              ? {
                  ...contact.latestMessage,
                  senderId: contact.latestMessage.senderId,
                  recipientId: contact.latestMessage.recipientId,
                  createdAt: contact.latestMessage.createdAt ? new Date(contact.latestMessage.createdAt).toISOString() : new Date().toISOString(),
                  updatedAt: contact.latestMessage.updatedAt ? new Date(contact.latestMessage.updatedAt).toISOString() : undefined,
                }
              : null,
            unreadCount: contact.unreadCount || 0,
            ownerId: contact.ownerId,
          }))
      : [];

    const result = {
      messages: {
        selectedChat: isValidObjectId(messages.selectedChat) ? messages.selectedChat : null,
        chats,
        chatList,
        chatListTimestamp: messages.chatListTimestamp || 0,
        messagesTimestamp: messages.messagesTimestamp || {},
        chatMessageCount,
      },
      auth: {
        token: typeof auth.token === 'string' && auth.token ? auth.token : null,
        userId: isValidObjectId(auth.userId) ? auth.userId : null,
        role: typeof auth.role === 'string' || typeof auth.role === 'number' ? Number(auth.role) : null,
        photo: typeof auth.photo === 'string' ? auth.photo : null,
        virtualNumber: typeof auth.virtualNumber === 'string' ? auth.virtualNumber : null,
        username: typeof auth.username === 'string' ? auth.username : null,
        privateKey: typeof auth.privateKey === 'string' && auth.privateKey ? auth.privateKey : null,
      },
    };
    return result;
  } catch (error) {
    await logClientError('Failed to load persisted state', error);
    return null;
  }
};

const messageSlice = createSlice({
  name: 'messages',
  initialState: {
    chats: {},
    selectedChat: null,
    chatListTimestamp: 0,
    messagesTimestamp: {},
    chatList: [],
    chatMessageCount: {},
  },
  reducers: {
    setMessages: (state, action) => {
      const { recipientId, messages } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !Array.isArray(messages)) {
        console.warn('setMessages: Invalid payload', { recipientId, messages });
        return;
      }
      if (!state.chatList.some((chat) => chat.id === recipientId)) {
        console.warn('setMessages: Recipient not in chatList', { recipientId });
        return;
      }
      const existingMessages = state.chats[recipientId] || [];
      const messageMap = new Map(existingMessages.map((msg) => [msg._id || msg.clientMessageId, msg]));
      const now = Date.now();
      messages.forEach((msg) => {
        const key = msg._id || msg.clientMessageId;
        if (!key || (msg.createdAt && now - new Date(msg.createdAt).getTime() > MESSAGE_TTL)) return;
        if (
          !isValidObjectId(msg.senderId) ||
          !isValidObjectId(msg.recipientId) ||
          (msg.senderId !== state.auth?.userId && msg.recipientId !== state.auth?.userId)
        ) {
          console.warn('setMessages: Invalid or unauthorized message', msg);
          return;
        }
        const normalizedMsg = {
          _id: msg._id || msg.clientMessageId,
          clientMessageId: msg.clientMessageId || msg._id,
          content: msg.content || '',
          status: ['sent', 'delivered', 'read', 'pending', 'failed'].includes(msg.status) ? msg.status : 'sent',
          senderId: msg.senderId,
          recipientId: msg.recipientId,
          contentType: msg.contentType || 'text',
          plaintextContent: msg.plaintextContent || '[Message not decrypted]',
          caption: msg.caption || undefined,
          replyTo: msg.replyTo && isValidObjectId(msg.replyTo) ? msg.replyTo : null,
          originalFilename: msg.originalFilename || undefined,
          senderVirtualNumber: msg.senderVirtualNumber || undefined,
          senderUsername: msg.senderUsername || undefined,
          senderPhoto: msg.senderPhoto || undefined,
          createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date().toISOString(),
          updatedAt: msg.updatedAt ? new Date(msg.updatedAt).toISOString() : undefined,
        };
        messageMap.set(key, normalizedMsg);
      });
      state.chats[recipientId] = Array.from(messageMap.values())
        .filter((msg) => now - new Date(msg.createdAt).getTime() <= MESSAGE_TTL)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(-MAX_MESSAGES_PER_CHAT);
      state.chatMessageCount[recipientId] = state.chats[recipientId].length;
      state.messagesTimestamp[recipientId] = now;
      console.log(`setMessages: Updated chats for recipientId ${recipientId} with ${state.chats[recipientId].length} messages`);
    },
    addMessage: (state, action) => {
      const { recipientId, message } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !message || !message.clientMessageId) {
        console.warn('addMessage: Invalid payload', { recipientId, message });
        return;
      }
      if (!state.chatList.some((chat) => chat.id === recipientId)) {
        console.warn('addMessage: Recipient not in chatList', { recipientId });
        return;
      }
      state.chats[recipientId] = state.chats[recipientId] || [];
      if (state.chats[recipientId].some((msg) => msg.clientMessageId === message.clientMessageId || msg._id === message.clientMessageId)) {
        console.log(`addMessage: Message ${message.clientMessageId} already exists for recipientId ${recipientId}`);
        return;
      }
      const normalizedMsg = {
        _id: message._id || message.clientMessageId,
        clientMessageId: message.clientMessageId || message._id,
        status: ['pending', 'sent', 'delivered', 'read', 'failed'].includes(message.status) ? message.status : 'pending',
        senderId: message.senderId,
        recipientId: message.recipientId,
        content: message.content || '',
        contentType: message.contentType || 'text',
        plaintextContent: message.plaintextContent || '',
        caption: message.caption || undefined,
        replyTo: message.replyTo && isValidObjectId(message.replyTo) ? message.replyTo : null,
        originalFilename: message.originalFilename || undefined,
        senderVirtualNumber: message.senderVirtualNumber || undefined,
        senderUsername: message.senderUsername || undefined,
        senderPhoto: message.senderPhoto || undefined,
        createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : new Date().toISOString(),
        updatedAt: message.updatedAt ? new Date(message.updatedAt).toISOString() : undefined,
      };
      if (
        isValidObjectId(normalizedMsg.senderId) &&
        isValidObjectId(normalizedMsg.recipientId) &&
        (normalizedMsg.senderId === state.auth?.userId || normalizedMsg.recipientId === state.auth?.userId)
      ) {
        state.chats[recipientId].push(normalizedMsg);
        state.chats[recipientId] = state.chats[recipientId].slice(-MAX_MESSAGES_PER_CHAT);
        state.chatMessageCount[recipientId] = (state.chatMessageCount[recipientId] || 0) + 1;
        state.messagesTimestamp[recipientId] = Date.now();
      } else {
        console.warn('addMessage: Invalid or unauthorized message', normalizedMsg);
      }
    },
    replaceMessage: (state, action) => {
      const { recipientId, message, replaceId } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !message || !replaceId || !message.clientMessageId) {
        console.warn('replaceMessage: Invalid payload', { recipientId, message, replaceId });
        return;
      }
      if (!state.chatList.some((chat) => chat.id === recipientId)) {
        console.warn('replaceMessage: Recipient not in chatList', { recipientId });
        return;
      }
      state.chats[recipientId] = state.chats[recipientId] || [];
      const index = state.chats[recipientId].findIndex(
        (msg) => msg.clientMessageId === replaceId || msg._id === replaceId
      );
      const normalizedMsg = {
        _id: message._id || message.clientMessageId,
        clientMessageId: message.clientMessageId || message._id,
        status: ['sent', 'delivered', 'read'].includes(message.status) ? message.status : 'sent',
        senderId: message.senderId,
        recipientId: message.recipientId,
        content: message.content || '',
        contentType: message.contentType || 'text',
        plaintextContent: message.plaintextContent || '',
        caption: message.caption || undefined,
        replyTo: message.replyTo && isValidObjectId(message.replyTo) ? message.replyTo : null,
        originalFilename: message.originalFilename || undefined,
        senderVirtualNumber: message.senderVirtualNumber || undefined,
        senderUsername: message.senderUsername || undefined,
        senderPhoto: message.senderPhoto || undefined,
        createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : new Date().toISOString(),
        updatedAt: message.updatedAt ? new Date(message.updatedAt).toISOString() : undefined,
      };
      if (
        isValidObjectId(normalizedMsg.senderId) &&
        isValidObjectId(normalizedMsg.recipientId) &&
        (normalizedMsg.senderId === state.auth?.userId || normalizedMsg.recipientId === state.auth?.userId)
      ) {
        if (index !== -1) {
          if (!state.chats[recipientId][index]._id || state.chats[recipientId][index]._id === replaceId) {
            state.chats[recipientId][index] = normalizedMsg;
          } else {
            console.log(`replaceMessage: Message ${replaceId} already updated with server ID, skipping`);
          }
        } else {
          if (!state.chats[recipientId].some((msg) => msg.clientMessageId === normalizedMsg.clientMessageId || msg._id === normalizedMsg._id)) {
            state.chats[recipientId].push(normalizedMsg);
            state.chats[recipientId] = state.chats[recipientId].slice(-MAX_MESSAGES_PER_CHAT);
            state.chatMessageCount[recipientId] = (state.chats[recipientId].length || 0);
          }
        }
        state.messagesTimestamp[recipientId] = Date.now();
      } else {
        console.warn('replaceMessage: Invalid or unauthorized message', normalizedMsg);
      }
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status, uploadProgress } = action.payload;
      if (
        !recipientId ||
        !isValidObjectId(recipientId) ||
        !messageId ||
        !state.chats[recipientId] ||
        !['pending', 'sent', 'delivered', 'read', 'failed'].includes(status)
      ) {
        console.warn('updateMessageStatus: Invalid payload', { recipientId, messageId, status });
        return;
      }
      if (!state.chatList.some((chat) => chat.id === recipientId)) {
        console.warn('updateMessageStatus: Recipient not in chatList', { recipientId });
        return;
      }
      const messageExists = state.chats[recipientId].some(
        (msg) => msg._id === messageId || msg.clientMessageId === messageId
      );
      if (!messageExists) {
        console.warn('updateMessageStatus: Message not found', { recipientId, messageId });
        return;
      }
      state.chats[recipientId] = state.chats[recipientId].map((msg) =>
        (msg._id === messageId || msg.clientMessageId === messageId)
          ? { ...msg, status, uploadProgress: uploadProgress !== undefined ? uploadProgress : msg.uploadProgress }
          : msg
      );
      state.messagesTimestamp[recipientId] = Date.now();
    },
    deleteMessage: (state, action) => {
      const { recipientId, messageId } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !messageId || !state.chats[recipientId]) {
        console.warn('deleteMessage: Invalid payload', { recipientId, messageId });
        return;
      }
      state.chats[recipientId] = state.chats[recipientId].filter(
        (msg) => msg._id !== messageId && msg.clientMessageId !== messageId
      );
      state.chatMessageCount[recipientId] = (state.chatMessageCount[recipientId] || 1) - 1;
      state.messagesTimestamp[recipientId] = Date.now();
    },
    setSelectedChat: (state, action) => {
      const recipientId = action.payload;
      if (recipientId === null) {
        state.selectedChat = null;
      } else if (isValidObjectId(recipientId) && state.chatList.some((chat) => chat.id === recipientId)) {
        state.chats[recipientId] = state.chats[recipientId] || [];
        state.selectedChat = recipientId;
      } else {
        console.warn('setSelectedChat: Invalid or unauthorized recipientId', recipientId);
      }
    },
    setChatList: (state, action) => {
      const now = Date.now();
      const payload = Array.isArray(action.payload) ? action.payload : [];
      const validContacts = payload.filter(
        (contact) =>
          isValidObjectId(contact.id) &&
          contact.virtualNumber &&
          contact.ownerId === state.auth?.userId // Ensure contacts belong to the user
      );
      if (validContacts.length > 0) {
        const existingChatMap = new Map(state.chatList.map((chat) => [chat.id, chat]));
        validContacts.forEach((contact) => {
          existingChatMap.set(contact.id, {
            id: contact.id,
            username: contact.username || existingChatMap.get(contact.id)?.username || 'Unknown',
            virtualNumber: contact.virtualNumber || existingChatMap.get(contact.id)?.virtualNumber || '',
            photo: contact.photo || existingChatMap.get(contact.id)?.photo || 'https://placehold.co/40x40',
            status: contact.status || existingChatMap.get(contact.id)?.status || 'offline',
            lastSeen: contact.lastSeen ? new Date(contact.lastSeen).toISOString() : existingChatMap.get(contact.id)?.lastSeen || null,
            latestMessage: contact.latestMessage
              ? {
                  ...contact.latestMessage,
                  senderId: contact.latestMessage.senderId,
                  recipientId: contact.latestMessage.recipientId,
                  createdAt: contact.latestMessage.createdAt
                    ? new Date(contact.latestMessage.createdAt).toISOString()
                    : new Date().toISOString(),
                  updatedAt: contact.latestMessage.updatedAt
                    ? new Date(contact.latestMessage.updatedAt).toISOString()
                    : undefined,
                }
              : existingChatMap.get(contact.id)?.latestMessage || null,
            unreadCount: contact.unreadCount || existingChatMap.get(contact.id)?.unreadCount || 0,
            ownerId: contact.ownerId,
          });
        });
        state.chatList = Array.from(existingChatMap.values());
        state.chatListTimestamp = now;
      } else {
        console.warn('setChatList: No valid contacts in payload, retaining existing chatList', payload);
      }
    },
    resetState: (state) => {
      Object.assign(state, messageSlice.getInitialState());
    },
    cleanupMessages: (state) => {
      const now = Date.now();
      Object.keys(state.chats).forEach((recipientId) => {
        if (!isValidObjectId(recipientId) || !state.chatList.some((chat) => chat.id === recipientId)) {
          console.warn(`cleanupMessages: Invalid or unauthorized recipientId ${recipientId}, removing`);
          delete state.chats[recipientId];
          delete state.chatMessageCount[recipientId];
          delete state.messagesTimestamp[recipientId];
          return;
        }
        state.chats[recipientId] = state.chats[recipientId].filter(
          (msg) =>
            now - new Date(msg.createdAt).getTime() <= MESSAGE_TTL &&
            (msg.senderId === state.auth?.userId || msg.recipientId === state.auth?.userId)
        );
        state.chatMessageCount[recipientId] = state.chats[recipientId].length;
        if (!state.chats[recipientId].length) {
          delete state.chats[recipientId];
          delete state.chatMessageCount[recipientId];
          delete state.messagesTimestamp[recipientId];
        }
      });
    },
  },
});

export const {
  setMessages,
  addMessage,
  replaceMessage,
  updateMessageStatus,
  deleteMessage,
  setSelectedChat,
  setChatList,
  resetState,
  cleanupMessages,
} = messageSlice.actions;

export const { setAuth, clearAuth } = authSlice.actions;

// Debounce utility
const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

// Persistence middleware
const persistenceMiddleware = (store) => {
  const debouncedPersist = debounce(async (state, action) => {
    try {
      const db = await initDB();
      if (!db) {
        console.warn('No database available, skipping persistence');
        return;
      }
      const serializableState = {
        messages: {
          selectedChat: isValidObjectId(state.messages.selectedChat) ? state.messages.selectedChat : null,
          chats: Object.keys(state.messages.chats).reduce((acc, recipientId) => {
            if (isValidObjectId(recipientId) && state.messages.chatList.some((chat) => chat.id === recipientId)) {
              acc[recipientId] = state.messages.chats[recipientId]
                .filter(
                  (msg) =>
                    isValidObjectId(msg.senderId) &&
                    isValidObjectId(msg.recipientId) &&
                    (msg.senderId === state.auth.userId || msg.recipientId === state.auth.userId)
                )
                .map((msg) => ({
                  _id: msg._id,
                  clientMessageId: msg.clientMessageId,
                  senderId: msg.senderId,
                  recipientId: msg.recipientId,
                  content: msg.content,
                  contentType: msg.contentType,
                  plaintextContent: msg.plaintextContent,
                  status: msg.status,
                  caption: msg.caption,
                  replyTo: msg.replyTo,
                  originalFilename: msg.originalFilename,
                  senderVirtualNumber: msg.senderVirtualNumber,
                  senderUsername: msg.senderUsername,
                  senderPhoto: msg.senderPhoto,
                  createdAt: msg.createdAt ? msg.createdAt : new Date().toISOString(),
                  updatedAt: msg.updatedAt ? msg.updatedAt : undefined,
                }));
            }
            return acc;
          }, {}),
          chatList: state.messages.chatList
            .filter((contact) => isValidObjectId(contact.id) && contact.ownerId === state.auth.userId)
            .map((contact) => ({
              id: contact.id,
              username: contact.username,
              virtualNumber: contact.virtualNumber,
              photo: contact.photo,
              status: contact.status,
              lastSeen: contact.lastSeen ? contact.lastSeen : null,
              latestMessage: contact.latestMessage
                ? {
                    ...contact.latestMessage,
                    senderId: contact.latestMessage.senderId,
                    recipientId: contact.latestMessage.recipientId,
                    createdAt: contact.latestMessage.createdAt ? contact.latestMessage.createdAt : new Date().toISOString(),
                    updatedAt: contact.latestMessage.updatedAt ? contact.latestMessage.updatedAt : undefined,
                  }
                : null,
              unreadCount: contact.unreadCount,
              ownerId: contact.ownerId,
            })),
          chatListTimestamp: state.messages.chatListTimestamp,
          messagesTimestamp: state.messages.messagesTimestamp,
          chatMessageCount: state.messages.chatMessageCount,
        },
        auth: {
          token: state.auth.token,
          userId: state.auth.userId,
          role: state.auth.role,
          photo: state.auth.photo,
          virtualNumber: state.auth.virtualNumber,
          username: state.auth.username,
          privateKey: null, // Do not persist privateKey for security
        },
      };
      await db.put(STORE_NAME, { key: 'state', value: serializableState });
      console.log('State persisted successfully');
    } catch (error) {
      await logClientError('Failed to persist state', error, state.auth.userId);
    }
  }, PERSISTENCE_DEBOUNCE_MS);

  return (next) => (action) => {
    const result = next(action);
    const actionsToPersist = [
      setSelectedChat.type,
      setAuth.type,
      setMessages.type,
      addMessage.type,
      replaceMessage.type,
      updateMessageStatus.type,
      deleteMessage.type,
      setChatList.type,
      cleanupMessages.type,
    ];

    if (actionsToPersist.includes(action.type)) {
      const state = store.getState();
      debouncedPersist(state, action);
    } else if (action.type === clearAuth.type || action.type === resetState.type) {
      requestAnimationFrame(async () => {
        try {
          const db = await initDB();
          if (!db) {
            console.warn('No database available, skipping state clear');
            return;
          }
          await db.delete(STORE_NAME, 'state'); // Clear all persisted state
          console.log('Persisted state cleared');
        } catch (error) {
          await logClientError('Failed to clear persisted state', error);
        }
      });
    }

    return result;
  };
};

// Create store
export const store = configureStore({
  reducer: {
    messages: messageSlice.reducer,
    auth: authSlice.reducer,
  },
  preloadedState: {
    messages: messageSlice.getInitialState(),
    auth: authSlice.getInitialState(),
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [
          setAuth.type,
          clearAuth.type,
          setMessages.type,
          addMessage.type,
          replaceMessage.type,
          updateMessageStatus.type,
          deleteMessage.type,
          setSelectedChat.type,
          setChatList.type,
          cleanupMessages.type,
        ],
        ignoredPaths: ['messages.chats', 'messages.chatList', 'auth'],
      },
    }).concat(persistenceMiddleware),
});

export const initializeStore = async () => {
  try {
    const persistedState = await loadPersistedState();
    if (persistedState) {
      store.dispatch(setAuth(persistedState.auth));
      Object.entries(persistedState.messages.chats).forEach(([recipientId, messages]) => {
        if (isValidObjectId(recipientId)) {
          store.dispatch(setMessages({ recipientId, messages }));
        }
      });
      store.dispatch(setChatList(persistedState.messages.chatList));
      store.dispatch(cleanupMessages());
      console.log('Store initialized with persisted state');
    } else {
      console.log('No valid persisted state, using initial state');
    }
  } catch (error) {
    await logClientError('Failed to initialize store with persisted state', error);
    // Continue with in-memory store
  }
};

// Run initialization
initializeStore();