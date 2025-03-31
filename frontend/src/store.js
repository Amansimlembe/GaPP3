import { configureStore, createSlice } from '@reduxjs/toolkit';

// Define the message slice
const messageSlice = createSlice({
  name: 'messages',
  initialState: {
    chats: {}, // Object with recipientId as keys and message arrays as values
    selectedChat: null, // Currently selected chat (recipientId)
  },
  reducers: {
    setMessages: (state, action) => {
      const { recipientId, messages } = action.payload;
      state.chats[recipientId] = messages;
    },
    addMessage: (state, action) => {
      const { recipientId, message } = action.payload;
      state.chats[recipientId] = state.chats[recipientId] || [];
      if (!state.chats[recipientId].some((msg) => msg._id === message._id)) {
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
    // Add a reducer for initial state loading
    setInitialState: (state, action) => {
      return { ...state, ...action.payload };
    },
  },
});

// Export actions
export const { setMessages, addMessage, updateMessageStatus, setSelectedChat, resetState, setInitialState } = messageSlice.actions;

// Custom middleware for persisting state to localStorage
const persistenceMiddleware = (store) => (next) => (action) => {
  const result = next(action);
  const actionsToPersist = [
    setMessages.type,
    addMessage.type,
    updateMessageStatus.type,
    setSelectedChat.type,
    resetState.type,
    setInitialState.type,
  ];

  if (actionsToPersist.includes(action.type)) {
    // Use requestAnimationFrame to defer persistence and avoid blocking renders
    requestAnimationFrame(() => {
      const state = store.getState().messages;
      try {
        localStorage.setItem('reduxState', JSON.stringify(state));
      } catch (error) {
        console.error('Failed to persist state:', error);
      }
    });
  }
  return result;
};

// Load persisted state safely
const loadPersistedState = () => {
  const persistedState = localStorage.getItem('reduxState');
  if (persistedState) {
    try {
      return JSON.parse(persistedState);
    } catch (error) {
      console.error('Failed to parse persisted state:', error);
      localStorage.removeItem('reduxState'); // Clear invalid state
      return undefined;
    }
  }
  return undefined;
};

// Configure the store with preloaded state
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
        // Ignore specific actions that might contain non-serializable data (e.g., Blobs)
        ignoredActions: [addMessage.type],
        ignoredPaths: ['messages.chats'],
      },
    }).concat(persistenceMiddleware),
});