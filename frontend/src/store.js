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
      console.log('Auth state updated:', { userId, username });
    },
    clearAuth: (state) => {
      state.token = null;
      state.userId = null;
      state.role = null;
      state.photo = null;
      state.virtualNumber = null;
      state.username = null;
      state.privateKey = null;
      console.log('Auth state cleared');
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
      if (!recipientId || !Array.isArray(messages)) {
        console.warn('Invalid setMessages payload:', action.payload);
        return;
      }
      state.chats = {
        ...state.chats,
        [recipientId]: messages.map((msg) => ({
          ...msg,
          _id: msg._id || msg.clientMessageId,
          clientMessageId: msg.clientMessageId || msg._id,
          content: msg.content || '',
          status: msg.status || 'pending',
        })),
      };
      console.log(`Set ${messages.length} messages for ${recipientId}`);
    },
    addMessage: (state, action) => {
      const { recipientId, message } = action.payload;
      if (!recipientId || !message || !message._id || !message.clientMessageId) {
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
      state.chats[recipientId] = [...state.chats[recipientId], { ...message }];
      console.log(`Added message ${message._id} (clientMessageId: ${message.clientMessageId}) to ${recipientId}`);
    },
    replaceMessage: (state, action) => {
      const { recipientId, message, replaceId } = action.payload;
      if (!recipientId || !message || !replaceId || !message._id || !message.clientMessageId) {
        console.warn('Invalid replaceMessage payload:', action.payload);
        return;
      }
      if (!state.chats[recipientId]) {
        console.warn(`No chat found for recipientId ${recipientId}`);
        state.chats[recipientId] = [];
      }
      const index = state.chats[recipientId]?.findIndex(
        (msg) => msg._id === replaceId || msg.clientMessageId === replaceId
      );
      if (index !== -1) {
        state.chats[recipientId][index] = { ...message };
        console.log(`Replaced message ${replaceId} with ${message._id} (clientMessageId: ${message.clientMessageId}) in ${recipientId}`);
      } else {
        console.warn(`Message ${replaceId} not found for replacement in ${recipientId}, adding as new`);
        state.chats[recipientId].push({ ...message });
      }
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status, uploadProgress } = action.payload;
      if (!recipientId || !messageId || !state.chats[recipientId]) {
        console.warn('Invalid updateMessageStatus payload:', action.payload);
        return;
      }
      state.chats[recipientId] = state.chats[recipientId].map((msg) =>
        msg._id === messageId || msg.clientMessageId === messageId
          ? {
              ...msg,
              status,
              uploadProgress: uploadProgress !== undefined ? uploadProgress : msg.uploadProgress,
            }
          : msg
      );
      console.log(`Updated status for message ${messageId} in ${recipientId} to ${status}`);
    },
    deleteMessage: (state, action) => {
      const { recipientId, messageId } = action.payload;
      if (!recipientId || !messageId || !state.chats[recipientId]) {
        console.warn('Invalid deleteMessage payload:', action.payload);
        return;
      }
      state.chats[recipientId] = state.chats[recipientId].filter(
        (msg) => msg._id !== messageId && msg.clientMessageId !== messageId
      );
      console.log(`Deleted message ${messageId} from ${recipientId}`);
    },
    setSelectedChat: (state, action) => {
      const recipientId = action.payload;
      if (recipientId === null) {
        state.selectedChat = null;
        console.log('Cleared selected chat');
      } else if (typeof recipientId === 'string' && isValidObjectId(recipientId)) {
        state.chats = {
          ...state.chats,
          [recipientId]: state.chats[recipientId] || [],
        };
        state.selectedChat = recipientId;
        console.log(`Selected chat: ${recipientId}`);
      } else {
        console.warn(`Invalid recipientId: ${recipientId}`);
      }
    },
    resetState: () => {
      console.log('Reset messages state');
      return { chats: {}, selectedChat: null };
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
  const actionsToPersist = [setSelectedChat.type, setAuth.type, setMessages.type, addMessage.type, replaceMessage.type, updateMessageStatus.type, deleteMessage.type];

  if (actionsToPersist.includes(action.type)) {
    requestAnimationFrame(() => {
      const state = store.getState();
      try {
        const serializableState = {
          messages: {
            selectedChat: typeof state.messages.selectedChat === 'string' ? state.messages.selectedChat : null,
            chats: Object.keys(state.messages.chats).reduce((acc, recipientId) => {
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
                createdAt: msg.createdAt,
                updatedAt: msg.updatedAt,
              }));
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
            privateKey: null, // Exclude privateKey for security
          },
        };
        localStorage.setItem('reduxState', JSON.stringify(serializableState));
        console.log('Persisted state:', {
          selectedChat: serializableState.messages.selectedChat,
          userId: serializableState.auth.userId,
          chatCount: Object.keys(serializableState.messages.chats).length,
        });
      } catch (error) {
        console.error('Failed to persist state:', error);
      }
    });
  } else if (action.type === clearAuth.type || action.type === resetState.type) {
    // Clear only auth-related data, keep messages in localStorage
    const state = store.getState();
    localStorage.setItem('reduxState', JSON.stringify({
      messages: state.messages,
      auth: {
        token: null,
        userId: null,
        role: null,
        photo: null,
        virtualNumber: null,
        username: null,
        privateKey: null,
      },
    }));
    console.log('Cleared auth state, preserved messages');
  }

  return result
};



const loadPersistedState = () => {
  try {
    const persistedState = localStorage.getItem('reduxState');
    if (persistedState) {
      const parsedState = JSON.parse(persistedState);
      if (
        parsedState &&
        parsedState.messages &&
        (typeof parsedState.messages.selectedChat === 'string' || parsedState.messages.selectedChat === null) &&
        parsedState.messages.chats &&
        parsedState.auth
      ) {
        const chats = Object.keys(parsedState.messages.chats).reduce((acc, recipientId) => {
          if (isValidObjectId(recipientId)) {
            acc[recipientId] = parsedState.messages.chats[recipientId].filter(
              (msg) => msg._id && msg.clientMessageId && isValidObjectId(msg.senderId) && isValidObjectId(msg.recipientId)
            ).map((msg) => ({
              ...msg,
              createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
              updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined,
              replyTo: msg.replyTo && isValidObjectId(msg.replyTo) ? msg.replyTo : null,
            }));
          }
          return acc;
        }, {});
        console.log('Loaded persisted state:', {
          selectedChat: parsedState.messages.selectedChat,
          userId: parsedState.auth.userId,
          chatCount: Object.keys(chats).length,
        });
        return {
          messages: { selectedChat: parsedState.messages.selectedChat, chats },
          auth: {
            token: parsedState.auth.token || null,
            userId: parsedState.auth.userId || null,
            role: parsedState.auth.role || null,
            photo: parsedState.auth.photo || null,
            virtualNumber: parsedState.auth.virtualNumber || null,
            username: parsedState.auth.username || null,
            privateKey: null,
          },
        };
      }
      console.warn('Invalid persisted state format');
    }
  } catch (error) {
    console.error('Failed to load persisted state:', error);
  }
  localStorage.removeItem('reduxState');
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