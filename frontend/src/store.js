import { configureStore, createSlice } from '@reduxjs/toolkit';

const messageSlice = createSlice({
  name: 'messages',
  initialState: {
    chats: {},
    selectedChat: null,
  },
  reducers: {
    setMessages: (state, action) => {
      const { recipientId, messages } = action.payload;
      state.chats[recipientId] = messages;
    },
    addMessage: (state, action) => {
      const { recipientId, message } = action.payload;
      state.chats[recipientId] = state.chats[recipientId] || [];
      if (!state.chats[recipientId].some((msg) => msg._id === message._id || msg.clientMessageId === message.clientMessageId)) {
        state.chats[recipientId].push(message);
      }
    },
    replaceMessage: (state, action) => {
      const { recipientId, message, replaceId } = action.payload;
      state.chats[recipientId] = state.chats[recipientId] || [];
      const index = state.chats[recipientId].findIndex((msg) => msg._id === replaceId || msg.clientMessageId === replaceId);
      if (index !== -1) {
        state.chats[recipientId][index] = { ...message };
      } else if (!state.chats[recipientId].some((msg) => msg._id === message._id || msg.clientMessageId === message.clientMessageId)) {
        state.chats[recipientId].push(message);
      }
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status, uploadProgress } = action.payload;
      if (state.chats[recipientId]) {
        const msgIndex = state.chats[recipientId].findIndex((msg) => msg._id === messageId || msg.clientMessageId === messageId);
        if (msgIndex !== -1) {
          state.chats[recipientId][msgIndex] = {
            ...state.chats[recipientId][msgIndex],
            status,
            ...(uploadProgress !== undefined && { uploadProgress }),
          };
        }
      }
    },
    deleteMessage: (state, action) => {
      const { recipientId, messageId } = action.payload;
      if (state.chats[recipientId]) {
        state.chats[recipientId] = state.chats[recipientId].filter((msg) => msg._id !== messageId);
      }
    },
    setSelectedChat: (state, action) => {
      state.selectedChat = action.payload;
    },
    resetState: () => ({
      chats: {},
      selectedChat: null,
    }),
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
        const serializableState = { selectedChat: state.selectedChat };
        localStorage.setItem('reduxState', JSON.stringify(serializableState));
      } catch (error) {
        console.error('Failed to persist state:', error);
        localStorage.removeItem('reduxState');
      }
    });
  }
  return result;
};
const loadPersistedState = () => {
  const persistedState = localStorage.getItem('reduxState');
  if (persistedState) {
    try {
      const parsedState = JSON.parse(persistedState);
      if (parsedState && (typeof parsedState.selectedChat === 'string' || parsedState.selectedChat === null)) {
        return { selectedChat: parsedState.selectedChat };
      }
      console.warn('Invalid persisted state format, clearing');
      localStorage.removeItem('reduxState');
      return undefined;
    } catch (error) {
      console.error('Failed to parse persisted state:', error);
      localStorage.removeItem('reduxState');
      return undefined;
    }
  }
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
        ignoredActions: [addMessage.type, replaceMessage.type, updateMessageStatus.type, deleteMessage.type],
        ignoredPaths: ['messages.chats'],
      },
    }).concat(persistenceMiddleware),
});