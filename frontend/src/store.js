
import { configureStore, createSlice } from '@reduxjs/toolkit';
import { openDB } from 'idb';

const DB_NAME = 'chatApp';
const STORE_NAME = 'reduxState';
const VERSION = 1;
const MESSAGE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
const MAX_MESSAGES_PER_CHAT = 1000;

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

// ObjectId validation
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

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
      state.token = typeof token === 'string' ? token : null;
      state.userId = isValidObjectId(userId) ? userId : null;
      state.role = typeof role === 'string' ? role : null;
      state.photo = typeof photo === 'string' ? photo : null;
      state.virtualNumber = typeof virtualNumber === 'string' ? virtualNumber : null;
      state.username = typeof username === 'string' ? username : null;
      state.privateKey = typeof privateKey === 'string' ? privateKey : null;
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
        if (!msg || (!msg._id && !msg.clientMessageId) || (msg.createdAt && now - new Date(msg.createdAt).getTime() > MESSAGE_TTL)) return;
        const key = msg._id || msg.clientMessageId;
        const normalizedMsg = {
          _id: msg._id || msg.clientMessageId,
          clientMessageId: msg.clientMessageId || msg._id,
          content: typeof msg.content === 'string' ? msg.content : '',
          status: ['sent', 'delivered', 'read', 'pending', 'failed'].includes(msg.status) ? msg.status : 'sent',
          senderId: msg.senderId?._id || msg.senderId,
          recipientId: msg.recipientId?._id || msg.recipientId,
          contentType: ['text', 'image', 'video', 'audio', 'document'].includes(msg.contentType) ? msg.contentType : 'text',
          plaintextContent: typeof msg.plaintextContent === 'string' ? msg.plaintextContent : '[Message not decrypted]',
          caption: typeof msg.caption === 'string' ? msg.caption : undefined,
          replyTo: msg.replyTo && isValidObjectId(msg.replyTo) ? msg.replyTo : null,
          originalFilename: typeof msg.originalFilename === 'string' ? msg.originalFilename : undefined,
          senderVirtualNumber: typeof msg.senderVirtualNumber === 'string' ? msg.senderVirtualNumber : undefined,
          senderUsername: typeof msg.senderUsername === 'string' ? msg.senderUsername : undefined,
          senderPhoto: typeof msg.senderPhoto === 'string' ? msg.senderPhoto : undefined,
          createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
          updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined,
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
      if (!recipientId || !isValidObjectId(recipientId) || !message || !message.clientMessageId || !isValidObjectId(message.senderId) || !isValidObjectId(message.recipientId)) return;
      state.chats[recipientId] = state.chats[recipientId] || [];
      if (state.chats[recipientId].some((msg) => msg._id === message._id || msg.clientMessageId === message.clientMessageId)) return;
      const normalizedMsg = {
        _id: message._id || message.clientMessageId,
        clientMessageId: message.clientMessageId || message._id,
        status: ['pending', 'sent', 'delivered', 'read', 'failed'].includes(message.status) ? message.status : 'pending',
        senderId: message.senderId?._id || message.senderId,
        recipientId: message.recipientId?._id || message.recipientId,
        content: typeof message.content === 'string' ? message.content : '',
        contentType: ['text', 'image', 'video', 'audio', 'document'].includes(message.contentType) ? message.contentType : 'text',
        plaintextContent: typeof message.plaintextContent === 'string' ? message.plaintextContent : '',
        caption: typeof message.caption === 'string' ? message.caption : undefined,
        replyTo: message.replyTo && isValidObjectId(message.replyTo) ? message.replyTo : null,
        originalFilename: typeof message.originalFilename === 'string' ? message.originalFilename : undefined,
        senderVirtualNumber: typeof message.senderVirtualNumber === 'string' ? message.senderVirtualNumber : undefined,
        senderUsername: typeof message.senderUsername === 'string' ? message.senderUsername : undefined,
        senderPhoto: typeof message.senderPhoto === 'string' ? message.senderPhoto : undefined,
        createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
        updatedAt: message.updatedAt ? new Date(message.updatedAt) : undefined,
      };
      state.chats[recipientId].push(normalizedMsg);
      state.chats[recipientId] = state.chats[recipientId].slice(-MAX_MESSAGES_PER_CHAT);
      state.chatMessageCount[recipientId] = (state.chatMessageCount[recipientId] || 0) + 1;
      state.messagesTimestamp[recipientId] = Date.now();
    },
    replaceMessage: (state, action) => {
      const { recipientId, message, replaceId } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !message || !replaceId || !message.clientMessageId || !isValidObjectId(message.senderId) || !isValidObjectId(message.recipientId)) return;
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
        content: typeof message.content === 'string' ? message.content : '',
        contentType: ['text', 'image', 'video', 'audio', 'document'].includes(message.contentType) ? message.contentType : 'text',
        plaintextContent: typeof message.plaintextContent === 'string' ? message.plaintextContent : '',
        caption: typeof message.caption === 'string' ? message.caption : undefined,
        replyTo: message.replyTo && isValidObjectId(message.replyTo) ? message.replyTo : null,
        originalFilename: typeof message.originalFilename === 'string' ? message.originalFilename : undefined,
        senderVirtualNumber: typeof message.senderVirtualNumber === 'string' ? message.senderVirtualNumber : undefined,
        senderUsername: typeof message.senderUsername === 'string' ? message.senderUsername : undefined,
        senderPhoto: typeof message.senderPhoto === 'string' ? message.senderPhoto : undefined,
        createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
        updatedAt: message.updatedAt ? new Date(message.updatedAt) : undefined,
      };
      if (index !== -1) {
        state.chats[recipientId][index] = normalizedMsg;
      } else {
        state.chats[recipientId].push(normalizedMsg);
        state.chats[recipientId] = state.chats[recipientId].slice(-MAX_MESSAGES_PER_CHAT);
        state.chatMessageCount[recipientId] = (state.chatMessageCount[recipientId] || 0) + 1;
      }
      state.messagesTimestamp[recipientId] = Date.now();
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status, uploadProgress } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !messageId || !state.chats[recipientId] || !['pending', 'sent', 'delivered', 'read', 'failed'].includes(status)) return;
      state.chats[recipientId] = state.chats[recipientId].map((msg) =>
        (msg._id === messageId || msg.clientMessageId === messageId)
          ? { ...msg, status, uploadProgress: uploadProgress !== undefined ? uploadProgress : msg.uploadProgress }
          : msg
      );
    },
    editMessage: (state, action) => {
      const { recipientId, messageId, newContent, plaintextContent } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !messageId || !state.chats[recipientId]) return;
      state.chats[recipientId] = state.chats[recipientId].map((msg) =>
        (msg._id === messageId || msg.clientMessageId === messageId)
          ? {
              ...msg,
              content: typeof newContent === 'string' ? newContent : msg.content,
              plaintextContent: typeof plaintextContent === 'string' ? plaintextContent : msg.plaintextContent,
              updatedAt: new Date(),
            }
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
      const contacts = action.payload.filter((contact) => isValidObjectId(contact.id) && typeof contact.username === 'string');
      state.chatList = contacts.map((contact) => ({
        id: contact.id,
        username: contact.username || 'Unknown',
        virtualNumber: typeof contact.virtualNumber === 'string' ? contact.virtualNumber : '',
        photo: typeof contact.photo === 'string' ? contact.photo : 'https://placehold.co/40x40',
        status: ['online', 'offline'].includes(contact.status) ? contact.status : 'offline',
        lastSeen: contact.lastSeen ? new Date(contact.lastSeen) : null,
        latestMessage: contact.latestMessage
          ? {
              ...contact.latestMessage,
              senderId: contact.latestMessage.senderId?._id || contact.latestMessage.senderId,
              recipientId: contact.latestMessage.recipientId?._id || contact.latestMessage.recipientId,
              createdAt: contact.latestMessage.createdAt ? new Date(contact.latestMessage.createdAt) : new Date(),
              updatedAt: contact.latestMessage.updatedAt ? new Date(contact.latestMessage.updatedAt) : undefined,
            }
          : null,
        unreadCount: Number.isInteger(contact.unreadCount) ? contact.unreadCount : 0,
      }));
      state.chatListTimestamp = Date.now();
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
          (msg) => now - new Date(msg.createdAt).getTime() <= MESSAGE_TTL && isValidObjectId(msg.senderId) && isValidObjectId(msg.recipientId)
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
  editMessage,
  deleteMessage,
  setSelectedChat,
  setChatList,
  resetState,
  cleanupMessages,
} = messageSlice.actions;

export const { setAuth, clearAuth } = authSlice.actions;

// Persistence middleware with IndexedDB
const persistenceMiddleware = (store) => (next) => (action) => {
  const result = next(action);
  const actionsToPersist = [
    setSelectedChat.type,
    setAuth.type,
    setMessages.type,
    addMessage.type,
    replaceMessage.type,
    updateMessageStatus.type,
    editMessage.type,
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
            chatList: state.messages.chatList.map((contact) => ({
              id: contact.id,
              username: contact.username,
              virtualNumber: contact.virtualNumber,
              photo: contact.photo,
              status: contact.status,
              lastSeen: contact.lastSeen ? contact.lastSeen.toISOString() : null,
              latestMessage: contact.latestMessage
                ? {
                    ...contact.latestMessage,
                    createdAt: contact.latestMessage.createdAt.toISOString(),
                    updatedAt: contact.latestMessage.updatedAt ? contact.latestMessage.updatedAt.toISOString() : undefined,
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
        console.error('Failed to persist state:', error);
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
      }
    });
  }

  return result;
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
            content: typeof msg.content === 'string' ? msg.content : '',
            contentType: ['text', 'image', 'video', 'audio', 'document'].includes(msg.contentType) ? msg.contentType : 'text',
            plaintextContent: typeof msg.plaintextContent === 'string' ? msg.plaintextContent : '[Message not decrypted]',
            status: msg.status || 'pending',
            senderId: msg.senderId,
            recipientId: msg.recipientId,
            caption: typeof msg.caption === 'string' ? msg.caption : undefined,
            replyTo: msg.replyTo && isValidObjectId(msg.replyTo) ? msg.replyTo : null,
            originalFilename: typeof msg.originalFilename === 'string' ? msg.originalFilename : undefined,
            senderVirtualNumber: typeof msg.senderVirtualNumber === 'string' ? msg.senderVirtualNumber : undefined,
            senderUsername: typeof msg.senderUsername === 'string' ? msg.senderUsername : undefined,
            senderPhoto: typeof msg.senderPhoto === 'string' ? msg.senderPhoto : undefined,
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
          .filter((contact) => isValidObjectId(contact.id))
          .map((contact) => ({
            id: contact.id,
            username: typeof contact.username === 'string' ? contact.username : 'Unknown',
            virtualNumber: typeof contact.virtualNumber === 'string' ? contact.virtualNumber : '',
            photo: typeof contact.photo === 'string' ? contact.photo : 'https://placehold.co/40x40',
            status: ['online', 'offline'].includes(contact.status) ? contact.status : 'offline',
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
            unreadCount: Number.isInteger(contact.unreadCount) ? contact.unreadCount : 0,
          }))
      : [];

    return {
      messages: {
        selectedChat: isValidObjectId(messages.selectedChat) ? messages.selectedChat : null,
        chats,
        chatList,
        chatListTimestamp: messages.chatListTimestamp || 0,
        messagesTimestamp: messages.messagesTimestamp || {},
        chatMessageCount,
      },
      auth: {
        token: typeof auth.token === 'string' ? auth.token : null,
        userId: isValidObjectId(auth.userId) ? auth.userId : null,
        role: typeof auth.role === 'string' ? auth.role : null,
        photo: typeof auth.photo === 'string' ? auth.photo : null,
        virtualNumber: typeof auth.virtualNumber === 'string' ? auth.virtualNumber : null,
        username: typeof auth.username === 'string' ? auth.username : null,
        privateKey: null,
      },
    };
  } catch (error) {
    console.error('Failed to load persisted state:', error);
    return null;
  }
};

// Hydrate store after initialization
export const initializeStore = async () => {
  try {
    const persistedState = await loadPersistedState();
    if (persistedState) {
      store.dispatch(setAuth(persistedState.auth));
      Object.keys(persistedState.messages.chats).forEach((recipientId) => {
        if (isValidObjectId(recipientId)) {
          store.dispatch(setMessages({ recipientId, messages: persistedState.messages.chats[recipientId] }));
        }
      });
      store.dispatch(setChatList(persistedState.messages.chatList));
      store.dispatch(cleanupMessages());
    }
  } catch (error) {
    console.error('Failed to initialize store:', error);
  }
};

// Create store with default initial state
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
          addMessage.type,
          replaceMessage.type,
          updateMessageStatus.type,
          editMessage.type,
          deleteMessage.type,
          setMessages.type,
          setAuth.type,
          setChatList.type,
          cleanupMessages.type,
        ],
        ignoredPaths: ['messages.chats', 'messages.chatList', 'auth'],
      },
    }).concat(persistenceMiddleware),
});

// Initialize store with persisted state
initializeStore();
