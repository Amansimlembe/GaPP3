import { configureStore, createSlice } from '@reduxjs/toolkit';

// Fallback ObjectId validation for browser
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

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
      console.log(`Added message ${message._id} to ${recipientId}`);
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
    console.log(`Replaced message ${replaceId} with ${message._id} in ${recipientId}`);
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

const persistenceMiddleware = (store) => (next) => (action) => {
  const result = next(action);
  const actionsToPersist = [setSelectedChat.type, resetState.type];

  if (actionsToPersist.includes(action.type)) {
    requestAnimationFrame(() => {
      const state = store.getState().messages;
      try {
        const serializableState = {
          selectedChat: typeof state.selectedChat === 'string' ? state.selectedChat : null,
        };
        localStorage.setItem('reduxState', JSON.stringify(serializableState));
        console.log('Persisted selectedChat:', serializableState.selectedChat);
      } catch (error) {
        console.error('Failed to persist state:', error);
        localStorage.removeItem('reduxState');
      }
    });
  }

  return result;
};

const loadPersistedState = () => {
  try {
    const persistedState = localStorage.getItem('reduxState');
    if (persistedState) {
      const parsedState = JSON.parse(persistedState);
      if (parsedState && (typeof parsedState.selectedChat === 'string' || parsedState.selectedChat === null)) {
        console.log('Loaded persisted selectedChat:', parsedState.selectedChat);
        return { selectedChat: parsedState.selectedChat, chats: {} };
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
  },
  preloadedState: {
    messages: loadPersistedState() || messageSlice.getInitialState(),
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [addMessage.type, replaceMessage.type, updateMessageStatus.type, deleteMessage.type, setMessages.type],
        ignoredPaths: ['messages.chats'],
      },
    }).concat(persistenceMiddleware),
});
