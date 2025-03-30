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
  },
});

// Export actions
export const { setMessages, addMessage, updateMessageStatus, setSelectedChat, resetState } = messageSlice.actions;

// Custom middleware for persisting state to localStorage
const persistenceMiddleware = (store) => (next) => (action) => {
  const result = next(action);
  const actionsToPersist = [
    setMessages.type,
    addMessage.type,
    updateMessageStatus.type,
    setSelectedChat.type,
    resetState.type,
  ];

  if (actionsToPersist.includes(action.type)) {
    // Use setTimeout to avoid blocking the main thread
    setTimeout(() => {
      const state = store.getState().messages;
      localStorage.setItem('reduxState', JSON.stringify(state));
    }, 0);
  }
  return result;
};

// Configure the store
export const store = configureStore({
  reducer: {
    messages: messageSlice.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false, // Disable serializability check since we handle persistence manually
    }).concat(persistenceMiddleware),
});

// Load persisted state on initialization
const persistedState = localStorage.getItem('reduxState');
if (persistedState) {
  try {
    const parsedState = JSON.parse(persistedState);
    store.dispatch({
      type: 'messages/setInitialState',
      payload: parsedState,
    });
  } catch (error) {
    console.error('Failed to load persisted state:', error);
    localStorage.removeItem('reduxState'); // Clear invalid state
  }
}

// Handle custom action for setting initial state
const originalReducer = messageSlice.reducer;
messageSlice.reducer = (state = messageSlice.getInitialState(), action) => {
  if (action.type === 'messages/setInitialState') {
    return { ...state, ...action.payload };
  }
  return originalReducer(state, action);
};