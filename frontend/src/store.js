import { configureStore, createSlice } from '@reduxjs/toolkit';

const messageSlice = createSlice({
  name: 'messages',
  initialState: { chats: {}, selectedChat: null },
  reducers: {
    setMessages: (state, action) => {
      state.chats[action.payload.recipientId] = action.payload.messages;
    },
    addMessage: (state, action) => {
      const { recipientId, message } = action.payload;
      state.chats[recipientId] = state.chats[recipientId] || [];
      // Avoid duplicates by checking if the message already exists
      if (!state.chats[recipientId].find((msg) => msg._id === message._id)) {
        state.chats[recipientId].push(message);
      }
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status } = action.payload;
      state.chats[recipientId] = (state.chats[recipientId] || []).map((msg) =>
        msg._id === messageId ? { ...msg, status } : msg
      );
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
export const store = configureStore({ reducer: { messages: messageSlice.reducer } });