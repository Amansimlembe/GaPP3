import { configureStore, createSlice } from '@reduxjs/toolkit';

// Fallback ObjectId validation
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
      state.token = token;
      state.userId = userId;
      state.role = role;
      state.photo = photo;
      state.virtualNumber = virtualNumber;
      state.username = username;
      state.privateKey = privateKey;
      console.debug('Auth state updated:', { userId, username });
    },
    clearAuth: (state) => {
      state.token = null;
      state.userId = null;
      state.role = null;
      state.photo = null;
      state.virtualNumber = null;
      state.username = null;
      state.privateKey = null;
      console.debug('Auth state cleared');
    },
  },
});

const messageSlice = createSlice({
  name: 'messages',
  initialState: {
    chats: {},
    selectedChat: null,
  },
  reducers: {
    setMessages: (state, action) => {
      const { recipientId, messages } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !Array.isArray(messages)) {
        console.warn('Invalid setMessages payload:', action.payload);
        return;
      }
      // --- Updated: Normalize and merge messages ---
      const existingMessages = state.chats[recipientId] || [];
      const messageMap = new Map(existingMessages.map((msg) => [msg._id || msg.clientMessageId, msg]));
      messages.forEach((msg) => {
        const key = msg._id || msg.clientMessageId;
        if (!key) {
          console.warn('Message missing _id or clientMessageId:', msg);
          return;
        }
        const normalizedMsg = {
          _id: msg._id || msg.clientMessageId,
          clientMessageId: msg.clientMessageId || msg._id,
          content: msg.content || '',
          status: ['sent', 'delivered', 'read'].includes(msg.status) ? msg.status : messageMap.get(key)?.status || 'sent',
          senderId: msg.senderId?._id || msg.senderId, // --- Updated: Handle populated senderId ---
          recipientId: msg.recipientId?._id || msg.recipientId, // --- Updated: Handle populated recipientId ---
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
        messageMap.set(key, { ...messageMap.get(key), ...normalizedMsg });
      });
      state.chats = {
        ...state.chats,
        [recipientId]: Array.from(messageMap.values()).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
      };
      console.debug(`Set ${messages.length} messages for ${recipientId}, total: ${state.chats[recipientId].length}`);
    },
    addMessage: (state, action) => {
      const { recipientId, message } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !message || !message.clientMessageId) {
        console.warn('Invalid addMessage payload:', action.payload);
        return;
      }
      state.chats = {
        ...state.chats,
        [recipientId]: state.chats[recipientId] || [],
      };
      if (state.chats[recipientId].some((msg) => msg._id === message._id || msg.clientMessageId === message.clientMessageId)) {
        console.warn('Duplicate message:', message._id || message.clientMessageId);
        return;
      }
      const normalizedMsg = {
        ...message,
        _id: message._id || message.clientMessageId,
        status: ['pending', 'sent', 'delivered', 'read', 'failed'].includes(message.status) ? message.status : 'pending',
        senderId: message.senderId?._id || message.senderId,
        recipientId: message.recipientId?._id || message.recipientId,
        contentType: message.contentType || 'text',
        plaintextContent: message.plaintextContent || '',
        createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
        updatedAt: message.updatedAt ? new Date(message.updatedAt) : undefined,
      };
      state.chats[recipientId].push(normalizedMsg);
      console.debug(`Added message ${message._id || message.clientMessageId} to ${recipientId}`);
    },
    replaceMessage: (state, action) => {
      const { recipientId, message, replaceId } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !message || !replaceId || !message.clientMessageId) {
        console.warn('Invalid replaceMessage payload:', action.payload);
        return;
      }
      if (!state.chats[recipientId]) {
        console.debug(`No chat found for ${recipientId}, initializing`);
        state.chats[recipientId] = [];
      }
      const index = state.chats[recipientId].findIndex(
        (msg) => msg._id === replaceId || msg.clientMessageId === replaceId
      );
      const normalizedMsg = {
        ...message,
        _id: message._id || message.clientMessageId,
        clientMessageId: message.clientMessageId || message._id,
        status: ['sent', 'delivered', 'read'].includes(message.status) ? message.status : 'sent',
        senderId: message.senderId?._id || message.senderId,
        recipientId: message.recipientId?._id || message.recipientId,
        contentType: message.contentType || 'text',
        plaintextContent: message.plaintextContent || '',
        createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
        updatedAt: message.updatedAt ? new Date(message.updatedAt) : undefined,
      };
      if (index !== -1) {
        state.chats[recipientId][index] = normalizedMsg;
        console.debug(`Replaced message ${replaceId} with ${message._id} in ${recipientId}`);
      } else {
        state.chats[recipientId].push(normalizedMsg);
        console.debug(`Message ${replaceId} not found, added ${message._id} to ${recipientId}`);
      }
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status, uploadProgress } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !messageId || !state.chats[recipientId] || !['pending', 'sent', 'delivered', 'read', 'failed'].includes(status)) {
        console.warn('Invalid updateMessageStatus payload:', action.payload);
        return;
      }
      state.chats[recipientId] = state.chats[recipientId].map((msg) =>
        (msg._id === messageId || msg.clientMessageId === messageId)
          ? {
              ...msg,
              status,
              uploadProgress: uploadProgress !== undefined ? uploadProgress : msg.uploadProgress,
            }
          : msg
      );
      console.debug(`Updated status for ${messageId} in ${recipientId} to ${status}`);
    },
    deleteMessage: (state, action) => {
      const { recipientId, messageId } = action.payload;
      if (!recipientId || !isValidObjectId(recipientId) || !messageId || !state.chats[recipientId]) {
        console.warn('Invalid deleteMessage payload:', action.payload);
        return;
      }
      state.chats[recipientId] = state.chats[recipientId].filter(
        (msg) => msg._id !== messageId && msg.clientMessageId !== messageId
      );
      console.debug(`Deleted message ${messageId} from ${recipientId}`);
    },
    setSelectedChat: (state, action) => {
      const recipientId = action.payload;
      if (recipientId === null) {
        state.selectedChat = null;
        console.debug('Cleared selected chat');
      } else if (isValidObjectId(recipientId)) {
        state.chats = {
          ...state.chats,
          [recipientId]: state.chats[recipientId] || [],
        };
        state.selectedChat = recipientId;
        console.debug(`Selected chat: ${recipientId}`);
      } else {
        console.warn(`Invalid recipientId: ${recipientId}`);
      }
    },
    resetState: (state) => {
      state.selectedChat = null;
      state.chats = {}; // --- Updated: Clear chats on reset ---
      console.debug('Reset messages state');
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
  resetState,
} = messageSlice.actions;

export const { setAuth, clearAuth } = authSlice.actions;

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
  ];

  if (actionsToPersist.includes(action.type)) {
    requestAnimationFrame(() => {
      const state = store.getState();
      try {
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
        localStorage.setItem('reduxState', JSON.stringify(serializableState));
        console.debug('Persisted state:', {
          selectedChat: serializableState.messages.selectedChat,
          userId: serializableState.auth.userId,
          chatCount: Object.keys(serializableState.messages.chats).length,
        });
      } catch (error) {
        console.error('Failed to persist state:', error);
      }
    });
  } else if (action.type === clearAuth.type || action.type === resetState.type) {
    try {
      localStorage.setItem('reduxState', JSON.stringify({
        messages: { selectedChat: null, chats: {} }, // --- Updated: Clear chats ---
        auth: authSlice.getInitialState(),
      }));
      console.debug('Cleared state');
    } catch (error) {
      console.error('Failed to persist state during clearAuth/resetState:', error);
    }
  }

  return result;
};

const loadPersistedState = () => {
  try {
    const persistedState = localStorage.getItem('reduxState');
    if (persistedState) {
      const parsedState = JSON.parse(persistedState);
      if (
        parsedState &&
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
              clientMessageId: msg.clientMessageId || msg._id || `temp-${Date.now()}-${Math.random()}`, // --- Updated: Fallback clientMessageId ---
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
        console.debug('Loaded persisted state:', {
          selectedChat: parsedState.messages.selectedChat,
          userId: auth.userId,
          chatCount: Object.keys(chats).length,
        });
        return {
          messages: { selectedChat: parsedState.messages.selectedChat, chats },
          auth,
        };
      }
      console.warn('Invalid persisted state format');
    }
  } catch (error) {
    console.error('Failed to load persisted state:', error);
  }
  // --- Updated: Simplified recovery logic ---
  try {
    const persistedState = localStorage.getItem('reduxState');
    if (persistedState) {
      const parsedState = JSON.parse(persistedState);
      if (parsedState.messages && parsedState.messages.chats) {
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
        const newState = {
          messages: { selectedChat: null, chats },
          auth: authSlice.getInitialState(),
        };
        localStorage.setItem('reduxState', JSON.stringify(newState));
        console.debug('Recovered messages, cleared invalid state');
        return newState;
      }
    }
  } catch (error) {
    console.error('Failed to recover partial state:', error);
  }
  localStorage.removeItem('reduxState');
  console.debug('Cleared invalid reduxState');
  return undefined;
};

export const store = configureStore({
  reducer: {
    messages: messageSlice.reducer,
    auth: authSlice.reducer,
  },
  preloadedState: loadPersistedState() || {
    messages: messageSlice.getInitialState(),
    auth: authSlice.getInitialState(),
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [addMessage.type, replaceMessage.type, updateMessageStatus.type, deleteMessage.type, setMessages.type, setAuth.type],
        ignoredPaths: ['messages.chats', 'auth'],
      },
    }).concat(persistenceMiddleware),
});