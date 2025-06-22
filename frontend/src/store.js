import { configureStore, createSlice } from '@reduxjs/toolkit';

// Changed: Use IndexedDB for large datasets
import { openDB } from 'idb';

const DB_NAME = 'chatApp';
const STORE_NAME = 'reduxState';
const VERSION = 1;

// Initialize IndexedDB
const initDB = async () => {
  return openDB(DB_NAME, VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    },
  });
};

// Fallback ObjectId validation
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

// Changed: Add message TTL (7 days)
const MESSAGE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

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
      state.token = token;
      state.userId = userId;
      state.role = role;
      state.photo = photo;
      state.virtualNumber = virtualNumber;
      state.username = username;
      state.privateKey = privateKey;
    },
    clearAuth: (state) => {
      Object.assign(state, authSlice.getInitialState());
    },
  },
});

const messageSlice = createSlice({
  name: 'messages',
  initialState: {
    chats: {},
    selectedChat: null,
    chatListTimestamp: 0,
    messagesTimestamp: {},
    chatList: [],
    // Changed: Track message count per chat for cleanup
    chatMessageCount: {},
  },
  reducers: {
    setMessages: (state, action) => {
      const { recipientId, messages } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !Array.isArray(messages)) {
        return;
      }
      const existingMessages = state.chats[recipientId] || [];
      const messageMap = new Map(existingMessages.map((msg) => [msg._id || msg.clientMessageId, msg]));
      const now = Date.now();
      messages.forEach((msg) => {
        const key = msg._id || msg.clientMessageId;
        if (!key) return;
        // Changed: Skip expired messages
        if (msg.createdAt && now - new Date(msg.createdAt).getTime() > MESSAGE_TTL) return;
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
          createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
          updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined,
        };
        messageMap.set(key, normalizedMsg);
      });
      const newMessages = Array.from(messageMap.values())
        .filter((msg) => now - new Date(msg.createdAt).getTime() <= MESSAGE_TTL)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      // Changed: Limit messages per chat (e.g., 1000)
      const MAX_MESSAGES_PER_CHAT = 1000;
      state.chats[recipientId] = newMessages.slice(-MAX_MESSAGES_PER_CHAT);
      state.chatMessageCount[recipientId] = state.chats[recipientId].length;
      state.messagesTimestamp[recipientId] = now;
    },
    addMessage: (state, action) => {
      const { recipientId, message } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !message || !message.clientMessageId) {
        return;
      }
      state.chats[recipientId] = state.chats[recipientId] || [];
      if (state.chats[recipientId].some((msg) => msg._id === message._id || msg.clientMessageId === message.clientMessageId)) {
        return;
      }
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
        createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
        updatedAt: message.updatedAt ? new Date(message.updatedAt) : undefined,
      };
      state.chats[recipientId].push(normalizedMsg);
      // Changed: Enforce message limit
      const MAX_MESSAGES_PER_CHAT = 1000;
      state.chats[recipientId] = state.chats[recipientId].slice(-MAX_MESSAGES_PER_CHAT);
      state.chatMessageCount[recipientId] = (state.chatMessageCount[recipientId] || 0) + 1;
      state.messagesTimestamp[recipientId] = Date.now();
    },
    replaceMessage: (state, action) => {
      const { recipientId, message, replaceId } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !message || !replaceId || !message.clientMessageId) {
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
        createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
        updatedAt: message.updatedAt ? new Date(message.updatedAt) : undefined,
      };
      if (index !== -1) {
        state.chats[recipientId][index] = normalizedMsg;
      } else {
        state.chats[recipientId].push(normalizedMsg);
        // Changed: Enforce message limit
        const MAX_MESSAGES_PER_CHAT = 1000;
        state.chats[recipientId] = state.chats[recipientId].slice(-MAX_MESSAGES_PER_CHAT);
        state.chatMessageCount[recipientId] = (state.chatMessageCount[recipientId] || 0) + 1;
      }
      state.messagesTimestamp[recipientId] = Date.now();
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status, uploadProgress } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !messageId || !state.chats[recipientId] || !['pending', 'sent', 'delivered', 'read', 'failed'].includes(status)) {
        return;
      }
      state.chats[recipientId] = state.chats[recipientId].map((msg) =>
        (msg._id === messageId || msg.clientMessageId === messageId)
          ? { ...msg, status, uploadProgress: uploadProgress !== undefined ? uploadProgress : msg.uploadProgress }
          : msg
      );
    },
    deleteMessage: (state, action) => {
      const { recipientId, messageId } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !messageId || !state.chats[recipientId]) {
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
      } else if (isValidObjectId(recipientId)) {
        state.chats[recipientId] = state.chats[recipientId] || [];
        state.selectedChat = recipientId;
      }
    },
    setChatList: (state, action) => {
      state.chatList = action.payload.filter((contact) => isValidObjectId(contact.id));
      state.chatListTimestamp = Date.now();
    },
    resetState: (state) => {
      Object.assign(state, messageSlice.getInitialState());
    },
    // Changed: Cleanup old messages
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

// Changed: Persistence middleware with IndexedDB
const persistenceMiddleware = (store) => (next) => (action) => {
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
    requestAnimationFrame(async () => {
      const state = store.getState();
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
                  createdAt: msg.createdAt.toISOString(),
                  updatedAt: msg.updatedAt ? msg.updatedAt.toISOString() : undefined,
                }));
              }
              return acc;
            }, {}),
            chatList: state.messages.chatList,
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
        console.error('Failed to persist state:', error);
        const db = await initDB();
        await db.delete(STORE_NAME, 'state');
      }
    });
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
        console.error('Failed to clear state:', error);
        const db = await initDB();
        await db.delete(STORE_NAME, 'state');
      }
    });
  }

  return result;
};

// Changed: Load state from IndexedDB
const loadPersistedState = async () => {
  try {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const persistedState = await store.get('state');
    await tx.done;
    if (persistedState?.value) {
      const parsedState = persistedState.value;
      if (
        parsedState.messages &&
        (isValidObjectId(parsedState.messages.selectedChat) || parsedState.messages.selectedChat === null) &&
        parsedState.messages.chats &&
        parsedState.auth
      ) {
        const chats = Object.keys(parsedState.messages.chats).reduce((acc, recipientId) => {
          if (isValidObjectId(recipientId)) {
            acc[recipientId] = parsedState.messages.chats[recipientId].filter(
              (msg) =>
                isValidObjectId(msg.senderId) &&
                isValidObjectId(msg.recipientId) &&
                ['sent', 'delivered', 'read', 'pending', 'failed'].includes(msg.status)
            ).map((msg) => ({
              _id: msg._id || msg.clientMessageId,
              clientMessageId: msg.clientMessageId || msg._id || `temp-${Date.now()}-${Math.random()}`,
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
            }));
          }
          return acc;
        }, {});
        const auth = {
          token: typeof parsedState.auth.token === 'string' ? parsedState.auth.token : null,
          userId: isValidObjectId(parsedState.auth.userId) ? parsedState.auth.userId : null,
          role: typeof parsedState.auth.role === 'string' ? parsedState.auth.role : null,
          photo: typeof parsedState.auth.photo === 'string' ? parsedState.auth.photo : null,
          virtualNumber: typeof parsedState.auth.virtualNumber === 'string' ? parsedState.auth.virtualNumber : null,
          username: typeof parsedState.auth.username === 'string' ? parsedState.auth.username : null,
          privateKey: null,
        };
        return {
          messages: {
            selectedChat: parsedState.messages.selectedChat,
            chats,
            chatList: parsedState.messages.chatList || [],
            chatListTimestamp: parsedState.messages.chatListTimestamp || 0,
            messagesTimestamp: parsedState.messages.messagesTimestamp || {},
            chatMessageCount: parsedState.messages.chatMessageCount || {},
          },
          auth,
        };
      }
    }
  } catch (error) {
    console.error('Failed to load persisted state:', error);
  }
  try {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const persistedState = await store.get('state');
    await tx.done;
    if (persistedState?.value?.messages?.chats) {
      const chats = Object.keys(persistedState.value.messages.chats).reduce((acc, recipientId) => {
        if (isValidObjectId(recipientId)) {
          acc[recipientId] = persistedState.value.messages.chats[recipientId].filter(
            (msg) =>
              isValidObjectId(msg.senderId) &&
              isValidObjectId(msg.recipientId) &&
              ['sent', 'delivered', 'read', 'pending', 'failed'].includes(msg.status)
          ).map((msg) => ({
            _id: msg._id || msg.clientMessageId,
            clientMessageId: msg.clientMessageId || msg._id || `temp-${Date.now()}-${Math.random()}`,
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
          }));
        }
        return acc;
      }, {});
      const newState = {
        messages: {
          selectedChat: null,
          chats,
          chatList: persistedState.value.messages.chatList || [],
          chatListTimestamp: persistedState.value.messages.chatListTimestamp || 0,
          messagesTimestamp: persistedState.value.messages.messagesTimestamp || {},
          chatMessageCount: persistedState.value.messages.chatMessageCount || {},
        },
        auth: authSlice.getInitialState(),
      };
      await db.put(STORE_NAME, { key: 'state', value: newState });
      return newState;
    }
  } catch (error) {
    console.error('Failed to recover partial state:', error);
  }
  const db = await initDB();
  await db.delete(STORE_NAME, 'state');
  return undefined;
};

export const store = configureStore({
  reducer: {
    messages: messageSlice.reducer,
    auth: authSlice.reducer,
  },
  preloadedState: async () => await loadPersistedState() || {
    messages: messageSlice.getInitialState(),
    auth: authSlice.getInitialState(),
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [addMessage.type, replaceMessage.type, updateMessageStatus.type, deleteMessage.type, setMessages.type, setAuth.type, setChatList.type, cleanupMessages.type],
        ignoredPaths: ['messages.chats', 'messages.chatList', 'auth'],
      },
    }).concat(persistenceMiddleware),
});