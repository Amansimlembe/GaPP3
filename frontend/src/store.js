import { configureStore, createSlice } from '@reduxjs/toolkit';
import { openDB } from 'idb';

// Constants
const DB_NAME = 'chatApp';
const STORE_NAME = 'reduxState';
const VERSION = 3;
const MAX_MESSAGES_PER_CHAT = 100;
const MESSAGE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const PERSISTENCE_DEBOUNCE_MS = 300;
const CACHE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ObjectId validation
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

// Initialize IndexedDB
const initDB = async () => {
  return openDB(DB_NAME, VERSION, {
    upgrade(db, oldVersion, newVersion) {
      if (oldVersion < 1) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
      if (oldVersion < 3) {
        console.log('Upgraded IndexedDB from version', oldVersion, 'to', newVersion);
      }
    },
  });
};

const errorLogTimestamps = new Map(); // Map to track error messages and their timestamps

const logError = async (message, error, userId = null) => {
  const now = Date.now();
  const errorEntry = errorLogTimestamps.get(message) || { count: 0, timestamps: [] };
  errorEntry.timestamps = errorEntry.timestamps.filter((ts) => now - ts < 60 * 1000);
  if (errorEntry.count >= 2 || errorEntry.timestamps.length >= 2) return;
  errorEntry.count += 1;
  errorEntry.timestamps.push(now);
  errorLogTimestamps.set(message, errorEntry);
  
  try {
    await fetch('https://gapp-6yc3.onrender.com/social/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: message,
        stack: error?.stack || '',
        userId,
        route: window.location.pathname,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error('Failed to log error:', err.message);
  }
};

// Auth Slice
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
      state.role = typeof role === 'string' ? role : null;
      state.photo = typeof photo === 'string' ? photo : null;
      state.virtualNumber = typeof virtualNumber === 'string' ? virtualNumber : null;
      state.username = typeof username === 'string' ? username : null;
      state.privateKey = privateKey || null;
    },
    clearAuth: (state) => {
      Object.assign(state, authSlice.getInitialState());
    },
  },
});

// Messages Slice
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
      if (!recipientId || !isValidObjectId(recipientId) || !Array.isArray(messages)) return;
      const existingMessages = state.chats[recipientId] || [];
      const messageMap = new Map(existingMessages.map((msg) => [msg._id || msg.clientMessageId, msg]));
      const now = Date.now();
      messages.forEach((msg) => {
        const key = msg._id || msg.clientMessageId;
        if (!key || (msg.createdAt && now - new Date(msg.createdAt).getTime() > MESSAGE_TTL)) return;
        const normalizedMsg = {
          _id: msg._id || msg.clientMessageId,
          clientMessageId: msg.clientMessageId || msg._id,
          content: msg.content || '',
          status: ['sent', 'delivered', 'read', 'pending', 'failed'].includes(msg.status) ? msg.status : 'sent',
          senderId: msg.senderId?._id || msg.senderId,
          recipientId: msg.recipientId?._id || msg.recipientId,
          contentType: msg.contentType || 'text',
          plaintextContent: msg.plaintextContent || '[Message not decrypted]',
          caption: msg.caption || undefined,
          replyTo: msg.replyTo && isValidObjectId(msg.replyTo) ? msg.replyTo : null,
          originalFilename: msg.originalFilename || undefined,
          senderVirtualNumber: msg.senderVirtualNumber || msg.senderId?.virtualNumber || undefined,
          senderUsername: msg.senderUsername || msg.senderId?.username || undefined,
          senderPhoto: msg.senderPhoto || msg.senderId?.photo || undefined,
          createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date().toISOString(),
          updatedAt: msg.updatedAt ? new Date(msg.updatedAt).toISOString() : undefined,
        };
        if (isValidObjectId(normalizedMsg.senderId) && isValidObjectId(normalizedMsg.recipientId)) {
          messageMap.set(key, normalizedMsg);
        }
      });
      state.chats[recipientId] = Array.from(messageMap.values())
        .filter((msg) => now - new Date(msg.createdAt).getTime() <= MESSAGE_TTL)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(-MAX_MESSAGES_PER_CHAT);
      state.chatMessageCount[recipientId] = state.chats[recipientId].length;
      state.messagesTimestamp[recipientId] = now;
    },
    addMessage: (state, action) => {
      const { recipientId, message } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !message || !message.clientMessageId) return;
      state.chats[recipientId] = state.chats[recipientId] || [];
      if (state.chats[recipientId].some((msg) => msg._id === message._id || msg.clientMessageId === message.clientMessageId)) return;
      const normalizedMsg = {
        _id: message._id || message.clientMessageId,
        clientMessageId: message.clientMessageId || message._id,
        status: ['pending', 'sent', 'delivered', 'read', 'failed'].includes(message.status) ? message.status : 'pending',
        senderId: message.senderId?._id || message.senderId,
        recipientId: message.recipientId?._id || message.recipientId,
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
      if (isValidObjectId(normalizedMsg.senderId) && isValidObjectId(normalizedMsg.recipientId)) {
        state.chats[recipientId].push(normalizedMsg);
        state.chats[recipientId] = state.chats[recipientId].slice(-MAX_MESSAGES_PER_CHAT);
        state.chatMessageCount[recipientId] = (state.chatMessageCount[recipientId] || 0) + 1;
        state.messagesTimestamp[recipientId] = Date.now();
      }
    },
    replaceMessage: (state, action) => {
      const { recipientId, message, replaceId } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !message || !replaceId || !message.clientMessageId) return;
      state.chats[recipientId] = state.chats[recipientId] || [];
      const index = state.chats[recipientId].findIndex(
        (msg) => msg.clientMessageId === replaceId || msg._id === replaceId
      );
      const normalizedMsg = {
        _id: message._id || message.clientMessageId,
        clientMessageId: message.clientMessageId || message._id,
        status: ['sent', 'delivered', 'read'].includes(message.status) ? message.status : 'sent',
        senderId: message.senderId?._id || message.senderId,
        recipientId: message.recipientId?._id || message.recipientId,
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
      if (isValidObjectId(normalizedMsg.senderId) && isValidObjectId(normalizedMsg.recipientId)) {
        if (index !== -1) {
          state.chats[recipientId][index] = normalizedMsg;
        } else {
          state.chats[recipientId].push(normalizedMsg);
          state.chats[recipientId] = state.chats[recipientId].slice(-MAX_MESSAGES_PER_CHAT);
          state.chatMessageCount[recipientId] = (state.chatMessageCount[recipientId] || 0) + 1;
        }
        state.messagesTimestamp[recipientId] = Date.now();
      }
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status, uploadProgress } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !messageId || !state.chats[recipientId] || !['pending', 'sent', 'delivered', 'read', 'failed'].includes(status)) return;
      state.chats[recipientId] = state.chats[recipientId].map((msg) =>
        (msg._id === messageId || msg.clientMessageId === messageId)
          ? { ...msg, status, uploadProgress: uploadProgress !== undefined ? uploadProgress : msg.uploadProgress }
          : msg
      );
      state.messagesTimestamp[recipientId] = Date.now();
    },
    deleteMessage: (state, action) => {
      const { recipientId, messageId } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !messageId || !state.chats[recipientId]) return;
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
      } else if (isValidObjectId(recipientId)) {
        state.chats[recipientId] = state.chats[recipientId] || [];
        state.selectedChat = recipientId;
      }
    },
    setChatList: (state, action) => {
      const now = Date.now();
      const payload = Array.isArray(action.payload) ? action.payload : [];
      state.chatList = payload
        .filter((contact) => isValidObjectId(contact.id) && contact.virtualNumber)
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
        }));
      state.chatListTimestamp = now;
    },
    resetState: (state) => {
      Object.assign(state, messageSlice.getInitialState());
    },
    cleanupMessages: (state) => {
      const now = Date.now();
      Object.keys(state.chats).forEach((recipientId) => {
        if (!isValidObjectId(recipientId)) {
          delete state.chats[recipientId];
          delete state.chatMessageCount[recipientId];
          delete state.messagesTimestamp[recipientId];
          return;
        }
        state.chats[recipientId] = state.chats[recipientId].filter(
          (msg) => now - new Date(msg.createdAt).getTime() <= MESSAGE_TTL
        );
        state.chatMessageCount[recipientId] = state.chats[recipientId].length;
        if (!state.chats[recipientId].length) {
          delete state.chats[recipientId];
          delete state.chatMessageCount[recipientId];
          delete state.messagesTimestamp[recipientId];
        }
      });
      if (now - state.chatListTimestamp > CACHE_TIMEOUT) {
        state.chatList = [];
        state.chatListTimestamp = 0;
      }
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
      const serializableState = {
        messages: {
          selectedChat: isValidObjectId(state.messages.selectedChat) ? state.messages.selectedChat : null,
          chats: Object.keys(state.messages.chats).reduce((acc, recipientId) => {
            if (isValidObjectId(recipientId)) {
              acc[recipientId] = state.messages.chats[recipientId].map((msg) => ({
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
          chatList: state.messages.chatList.map((contact) => ({
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
          privateKey: null,
        },
      };
      await db.put(STORE_NAME, { key: 'state', value: serializableState });
    } catch (error) {
      logError('Failed to persist state', error, state.auth.userId);
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
          await db.put(STORE_NAME, {
            key: 'state',
            value: {
              messages: messageSlice.getInitialState(),
              auth: authSlice.getInitialState(),
            },
          });
        } catch (error) {
          logError('Failed to clear persisted state', error);
        }
      });
    }

    return result;
  };
};

// Load persisted state
const loadPersistedState = async () => {
  try {
    const db = await initDB();
    const persistedState = await db.get(STORE_NAME, 'state');
    if (!persistedState?.value) return null;

    const { messages, auth } = persistedState.value;
    if (!messages || !auth) return null;

    const now = Date.now();
    const chats = Object.keys(messages.chats).reduce((acc, recipientId) => {
      if (isValidObjectId(recipientId)) {
        acc[recipientId] = messages.chats[recipientId]
          .filter(
            (msg) =>
              isValidObjectId(msg.senderId) &&
              isValidObjectId(msg.recipientId) &&
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
            createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
            updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined,
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
          .filter((contact) => isValidObjectId(contact.id) && contact.virtualNumber)
          .map((contact) => ({
            id: contact.id,
            username: contact.username || 'Unknown',
            virtualNumber: contact.virtualNumber || '',
            photo: contact.photo || 'https://placehold.co/40x40',
            status: contact.status || 'offline',
            lastSeen: contact.lastSeen ? new Date(contact.lastSeen) : null,
            latestMessage: contact.latestMessage
              ? {
                  ...contact.latestMessage,
                  senderId: contact.latestMessage.senderId,
                  recipientId: contact.latestMessage.recipientId,
                  createdAt: contact.latestMessage.createdAt ? new Date(contact.latestMessage.createdAt) : new Date(),
                  updatedAt: contact.latestMessage.updatedAt ? new Date(contact.latestMessage.updatedAt) : undefined,
                }
              : null,
            unreadCount: contact.unreadCount || 0,
          }))
      : [];

    return {
      messages: {
        selectedChat: isValidObjectId(messages.selectedChat) ? messages.selectedChat : null,
        chats,
        chatList: now - messages.chatListTimestamp > CACHE_TIMEOUT ? [] : chatList,
        chatListTimestamp: now - messages.chatListTimestamp > CACHE_TIMEOUT ? 0 : messages.chatListTimestamp,
        messagesTimestamp: messages.messagesTimestamp || {},
        chatMessageCount,
      },
      auth: {
        token: typeof auth.token === 'string' && auth.token ? auth.token : null,
        userId: isValidObjectId(auth.userId) ? auth.userId : null,
        role: typeof auth.role === 'string' ? auth.role : null,
        photo: typeof auth.photo === 'string' ? auth.photo : null,
        virtualNumber: typeof auth.virtualNumber === 'string' ? auth.virtualNumber : null,
        username: typeof auth.username === 'string' ? auth.username : null,
        privateKey: null,
      },
    };
  } catch (error) {
    logError('Failed to load persisted state', error);
    return null;
  }
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
    console.log('Persisted state loaded:', persistedState); // Debug
    if (persistedState) {
      store.dispatch(setAuth(persistedState.auth));
      Object.entries(persistedState.messages.chats).forEach(([recipientId, messages]) => {
        if (isValidObjectId(recipientId)) {
          store.dispatch(setMessages({ recipientId, messages }));
        }
      });
      store.dispatch(setChatList(persistedState.messages.chatList));
      store.dispatch(cleanupMessages());
    }
  } catch (error) {
    logError('Failed to initialize store with persisted state', error);
  }
};

// Run initialization
initializeStore();