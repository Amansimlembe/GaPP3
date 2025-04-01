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
      // Only add if the message doesn't already exist
      if (!state.chats[recipientId].some((msg) => msg._id === message._id)) {
        state.chats[recipientId].push(message);
      }
    },
    replaceMessage: (state, action) => {
      if (!action.payload || typeof action.payload !== 'object') {
        console.error('Invalid payload for replaceMessage:', action.payload);
        return state; // Prevent destructuring error
      }
      const { recipientId, message, replaceId } = action.payload;
      if (!recipientId || !message || !replaceId) {
        console.error('Missing required fields in replaceMessage payload:', { recipientId, message, replaceId });
        return state;
      }
      state.chats[recipientId] = state.chats[recipientId] || [];
      const index = state.chats[recipientId].findIndex((msg) => msg._id === replaceId);
      if (index !== -1) {
        state.chats[recipientId][index] = { ...message };
      } else if (!state.chats[recipientId].some((msg) => msg._id === message._id)) {
        state.chats[recipientId].push(message);
      }
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status } = action.payload;
      if (state.chats[recipientId]) {
        const msgIndex = state.chats[recipientId].findIndex((msg) => msg._id === messageId);
        if (msgIndex !== -1) {
          state.chats[recipientId][msgIndex] = { ...state.chats[recipientId][msgIndex], status };
        }
      }
    },
    setSelectedChat: (state, action) => {
      state.selectedChat = action.payload;
    },
    resetState: () => ({
      chats: {},
      selectedChat: null,
    }),
    setInitialState: (state, action) => {
      return { ...state, ...action.payload };
    },
  },
});

console.log('store.js loaded, exporting actions');

export const {
  setMessages,
  addMessage,
  replaceMessage,
  updateMessageStatus,
  setSelectedChat,
  resetState,
  setInitialState,
} = messageSlice.actions;

console.log('Exported replaceMessage:', replaceMessage);
const persistenceMiddleware = (store) => (next) => (action) => {
  const result = next(action);
  const actionsToPersist = [
    setMessages.type,
    addMessage.type,
    replaceMessage.type,
    updateMessageStatus.type,
    setSelectedChat.type,
    resetState.type,
    setInitialState.type,
  ];

  if (actionsToPersist.includes(action.type)) {
    requestAnimationFrame(() => {
      const state = store.getState().messages;
      try {
        const serializableState = {
          ...state,
          chats: Object.fromEntries(
            Object.entries(state.chats).map(([key, messages]) => [
              key,
              messages.map((msg) => ({
                ...msg,
                // Handle non-serializable content (e.g., Blob URLs from media)
                content: typeof msg.content === 'string' ? msg.content : '[Media Content]',
              })),
            ])
          ),
        };
        localStorage.setItem('reduxState', JSON.stringify(serializableState));
      } catch (error) {
        console.error('Failed to persist state:', error);
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
      // Ensure chats is an object and not corrupted
      if (parsedState && typeof parsedState.chats === 'object' && parsedState.chats !== null) {
        return parsedState;
      }
      throw new Error('Invalid persisted state format');
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
        ignoredActions: [addMessage.type, replaceMessage.type],
        ignoredPaths: ['messages.chats'],
      },
    }).concat(persistenceMiddleware),
});