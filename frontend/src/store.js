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
      state.chats[recipientId].push(message);
    },
    setSelectedChat: (state, action) => {
      state.selectedChat = action.payload;
    }
  }
});

export const { setMessages, addMessage, setSelectedChat } = messageSlice.actions;
export const store = configureStore({ reducer: { messages: messageSlice.reducer } });     