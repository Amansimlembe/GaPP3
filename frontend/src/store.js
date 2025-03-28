import { configureStore, createSlice } from '@reduxjs/toolkit';

const messageSlice = createSlice({
  name: 'messages',
  initialState: { chats: {}, selectedChat: null },
  reducers: {
    setMessages: (state, action) => {
      const { recipientId, messages } = action.payload;
      // Assume messages are already sorted from backend
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
    resetState: (state) => {
      state.chats = {};
      state.selectedChat = null;
    },
  },
});

export const { setMessages, addMessage, updateMessageStatus, setSelectedChat, resetState } = messageSlice.actions;

export const store = configureStore({
  reducer: { messages: messageSlice.reducer },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat((store) => (next) => (action) => {
      const result = next(action);
      if ([setMessages.type, addMessage.type, updateMessageStatus.type].includes(action.type)) {
        // Asynchronous localStorage write to avoid blocking
        setTimeout(() => {
          localStorage.setItem('reduxState', JSON.stringify(store.getState().messages));
        }, 0);
      }
      return result;
    }),
});

// Load persisted state on initialization
const persistedState = localStorage.getItem('reduxState');
if (persistedState) {
  store.dispatch({
    type: 'messages/setInitialState',
    payload: JSON.parse(persistedState),
  });
}

// Add a custom reducer to handle initial state loading
messageSlice.reducer = (state = messageSlice.getInitialState(), action) => {
  if (action.type === 'messages/setInitialState') {
    return { ...state, ...action.payload };
  }
  return messageSlice.reducer(state, action);
};