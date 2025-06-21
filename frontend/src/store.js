import { configureStore, createSlice, createAsyncThunk } from '@reduxjs/toolkit';

// Fallback ObjectId validation
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

// Auth Slice
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
    error: null,
  },
  reducers: {
    setAuth: (state, action) => {
      const { token, userId, role, photo, virtualNumber, username, privateKey } = action.payload;
      state.token = token || null;
      state.userId = userId || null;
      state.role = Number.isFinite(role) ? Number(role) : null;
      state.photo = photo || 'https://placehold.co/40x40';
      state.virtualNumber = virtualNumber || null;
      state.username = username || null;
      state.privateKey = privateKey || null;
      state.error = null;
      console.log('Auth state updated:', { userId, username });
    },
    setAuthError: (state, action) => {
      state.error = action.payload;
      console.log('Auth error set:', action.payload);
    },
    clearAuthData: (state) => {
      state.token = null;
      state.userId = null;
      state.role = null;
      state.photo = null;
      state.virtualNumber = null;
      state.username = null;
      state.privateKey = null;
      state.error = null;
      console.log('Auth state cleared');
    },
  },
});

// Messages Slice
const messageSlice = createSlice({
  name: 'messages',
  initialState: {
    chats: {}, // { recipientId: [messages] }
    chatList: [], // [{ id, username, virtualNumber, photo, status, lastSeen, latestMessage, unreadCount }]
    selectedChat: null,
    error: null,
  },
  reducers: {
    setChatList: (state, action) => {
      state.chatList = Array.isArray(action.payload)
        ? action.payload.map((contact) => ({
            id: String(contact.id),
            username: contact.username || 'Unknown',
            virtualNumber: contact.virtualNumber || '',
            photo: contact.photo || 'https://placehold.co/40x40',
            status: contact.status || 'offline',
            lastSeen: contact.lastSeen || null,
            latestMessage: contact.latestMessage
              ? {
                  ...contact.latestMessage,
                  _id: String(contact.latestMessage._id),
                  senderId: String(contact.latestMessage.senderId),
                  recipientId: String(contact.latestMessage.recipientId),
                  clientMessageId: String(contact.latestMessage.clientMessageId || contact.latestMessage._id),
                }
              : null,
            unreadCount: Number.isFinite(contact.unreadCount) ? contact.unreadCount : 0,
          }))
        : [];
      state.error = null;
      console.log(`Set chat list with ${state.chatList.length} contacts`);
    },
    setMessages: (state, action) => {
      const { recipientId, messages } = action.payload;
      if (!isValidObjectId(recipientId) || !Array.isArray(messages)) {
        console.warn('Invalid setMessages payload:', action.payload);
        state.error = 'Invalid messages data';
        return;
      }
      state.chats[recipientId] = messages.map((msg) => ({
        ...msg,
        _id: String(msg._id || msg.clientMessageId),
        clientMessageId: String(msg.clientMessageId || msg._id),
        senderId: String(msg.senderId),
        recipientId: String(msg.recipientId),
        content: msg.content || '',
        status: msg.status || 'pending',
        createdAt: msg.createdAt || new Date().toISOString(),
        replyTo: msg.replyTo ? { ...msg.replyTo, _id: String(msg.replyTo._id) } : null,
      }));
      state.error = null;
      console.log(`Set ${messages.length} messages for ${recipientId}`);
    },
    addMessage: (state, action) => {
      const { recipientId, message } = action.payload;
      if (!isValidObjectId(recipientId) || !message || !isValidObjectId(message._id) || !message.clientMessageId) {
        console.warn('Invalid addMessage payload:', action.payload);
        state.error = 'Invalid message data';
        return;
      }
      const normalizedMessage = {
        ...message,
        _id: String(message._id),
        clientMessageId: String(message.clientMessageId),
        senderId: String(message.senderId),
        recipientId: String(message.recipientId),
        content: message.content || '',
        status: message.status || 'pending',
        createdAt: message.createdAt || new Date().toISOString(),
        replyTo: message.replyTo ? { ...message.replyTo, _id: String(message.replyTo._id) } : null,
      };
      state.chats[recipientId] = state.chats[recipientId] || [];
      if (state.chats[recipientId].some((msg) => msg._id === normalizedMessage._id || msg.clientMessageId === normalizedMessage.clientMessageId)) {
        console.warn('Duplicate message:', normalizedMessage._id);
        return;
      }
      state.chats[recipientId].push(normalizedMessage);
      // Update chatList latestMessage and unreadCount
      const contactIndex = state.chatList.findIndex((contact) => contact.id === recipientId);
      if (contactIndex !== -1 && message.senderId !== state.auth?.userId) {
        state.chatList[contactIndex].latestMessage = normalizedMessage;
        state.chatList[contactIndex].unreadCount = (state.chatList[contactIndex].unreadCount || 0) + 1;
      }
      console.log(`Added message ${normalizedMessage._id} to ${recipientId}`);
    },
    replaceMessage: (state, action) => {
      const { recipientId, message, replaceId } = action.payload;
      if (!isValidObjectId(recipientId) || !message || !isValidObjectId(message._id) || !message.clientMessageId || !replaceId) {
        console.warn('Invalid replaceMessage payload:', action.payload);
        state.error = 'Invalid replace message data';
        return;
      }
      state.chats[recipientId] = state.chats[recipientId] || [];
      const normalizedMessage = {
        ...message,
        _id: String(message._id),
        clientMessageId: String(message.clientMessageId),
        senderId: String(message.senderId),
        recipientId: String(message.recipientId),
        content: message.content || '',
        status: message.status || 'pending',
        createdAt: message.createdAt || new Date().toISOString(),
      };
      const index = state.chats[recipientId].findIndex(
        (msg) => msg._id === replaceId || msg.clientMessageId === replaceId
      );
      if (index !== -1) {
        state.chats[recipientId][index] = normalizedMessage;
        console.log(`Replaced message ${replaceId} with ${normalizedMessage._id} in ${recipientId}`);
      } else {
        state.chats[recipientId].push(normalizedMessage);
        console.log(`Message ${replaceId} not found, added ${normalizedMessage._id} to ${recipientId}`);
      }
      // Update chatList latestMessage
      const contactIndex = state.chatList.findIndex((contact) => contact.id === recipientId);
      if (contactIndex !== -1 && normalizedMessage._id === state.chatList[contactIndex].latestMessage?._id) {
        state.chatList[contactIndex].latestMessage = normalizedMessage;
      }
    },
    updateMessageStatus: (state, action) => {
      const { recipientId, messageId, status, uploadProgress } = action.payload;
      if (!isValidObjectId(recipientId) || !messageId || !state.chats[recipientId]) {
        console.warn('Invalid updateMessageStatus payload:', action.payload);
        state.error = 'Invalid message status update';
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
      console.log(`Updated status for message ${messageId} in ${recipientId} to ${status}`);
    },
    deleteMessage: (state, action) => {
      const { recipientId, messageId } = action.payload;
      if (!isValidObjectId(recipientId) || !messageId || !state.chats[recipientId]) {
        console.warn('Invalid deleteMessage payload:', action.payload);
        state.error = 'Invalid delete message data';
        return;
      }
      const deletedMessage = state.chats[recipientId].find((msg) => msg._id === messageId || msg.clientMessageId === messageId);
      state.chats[recipientId] = state.chats[recipientId].filter(
        (msg) => msg._id !== messageId && msg.clientMessageId !== messageId
      );
      // Update chatList latestMessage
      const contactIndex = state.chatList.findIndex((contact) => contact.id === recipientId);
      if (contactIndex !== -1 && deletedMessage?._id === state.chatList[contactIndex].latestMessage?._id) {
        const latestMessage = state.chats[recipientId].length
          ? state.chats[recipientId].reduce((latest, msg) =>
              new Date(msg.createdAt) > new Date(latest.createdAt) ? msg : latest
            )
          : null;
        state.chatList[contactIndex].latestMessage = latestMessage;
      }
      console.log(`Deleted message ${messageId} from ${recipientId}`);
    },
    setSelectedChat: (state, action) => {
      const recipientId = action.payload;
      if (recipientId === null) {
        state.selectedChat = null;
        console.log('Cleared selected chat');
      } else if (isValidObjectId(recipientId)) {
        state.chats[recipientId] = state.chats[recipientId] || [];
        state.selectedChat = recipientId;
        // Reset unreadCount when selecting chat
        const contactIndex = state.chatList.findIndex((contact) => contact.id === recipientId);
        if (contactIndex !== -1) {
          state.chatList[contactIndex].unreadCount = 0;
        }
        console.log(`Selected chat: ${recipientId}`);
      } else {
        console.warn(`Invalid recipientId: ${recipientId}`);
        state.error = 'Invalid chat selection';
      }
    },
    addContact: (state, action) => {
      const contact = action.payload;
      if (!isValidObjectId(contact.id)) {
        console.warn('Invalid contact data:', contact);
        state.error = 'Invalid contact data';
        return;
      }
      const normalizedContact = {
        id: String(contact.id),
        username: contact.username || 'Unknown',
        virtualNumber: contact.virtualNumber || '',
        photo: contact.photo || 'https://placehold.co/40x40',
        status: contact.status || 'offline',
        lastSeen: contact.lastSeen || null,
        latestMessage: contact.latestMessage
          ? {
              ...contact.latestMessage,
              _id: String(contact.latestMessage._id),
              senderId: String(contact.latestMessage.senderId),
              recipientId: String(contact.latestMessage.recipientId),
              clientMessageId: String(contact.latestMessage.clientMessageId || contact.latestMessage._id),
            }
          : null,
        unreadCount: Number.isFinite(contact.unreadCount) ? contact.unreadCount : 0,
      };
      if (!state.chatList.some((c) => c.id === normalizedContact.id)) {
        state.chatList.push(normalizedContact);
        console.log(`Added contact ${normalizedContact.id} to chatList`);
      }
    },
    updateContactStatus: (state, action) => {
      const { userId, status, lastSeen } = action.payload;
      if (!isValidObjectId(userId)) {
        console.warn('Invalid updateContactStatus payload:', action.payload);
        return;
      }
      const contactIndex = state.chatList.findIndex((contact) => contact.id === userId);
      if (contactIndex !== -1) {
        state.chatList[contactIndex].status = status || 'offline';
        state.chatList[contactIndex].lastSeen = lastSeen || null;
        console.log(`Updated status for contact ${userId} to ${status}`);
      }
    },
    removeContact: (state, action) => {
      const userId = action.payload;
      if (!isValidObjectId(userId)) {
        console.warn('Invalid removeContact payload:', userId);
        return;
      }
      state.chatList = state.chatList.filter((contact) => contact.id !== userId);
      delete state.chats[userId];
      if (state.selectedChat === userId) {
        state.selectedChat = null;
      }
      console.log(`Removed contact ${userId} from chatList`);
    },
    setMessagesError: (state, action) => {
      state.error = action.payload;
      console.log('Messages error set:', action.payload);
    },
    resetState: (state) => {
      state.chats = {};
      state.chatList = [];
      state.selectedChat = null;
      state.error = null;
      console.log('Reset messages state');
    },
  },
});

// Async Thunks for Socket.IO Events
export const handleSocketMessage = createAsyncThunk(
  'messages/handleSocketMessage',
  async (message, { dispatch, getState }) => {
    const { auth } = getState();
    if (!isValidObjectId(message.senderId) || !isValidObjectId(message.recipientId)) {
      console.warn('Invalid socket message:', message);
      return;
    }
    const recipientId = message.senderId === auth.userId ? message.recipientId : message.senderId;
    dispatch(addMessage({ recipientId, message }));
    // Update sender's contact info if available
    if (message.senderId !== auth.userId && message.senderUsername) {
      dispatch(
        addContact({
          id: message.senderId,
          username: message.senderUsername,
          virtualNumber: message.senderVirtualNumber,
          photo: message.senderPhoto,
          status: 'online',
          lastSeen: new Date().toISOString(),
          latestMessage: message,
          unreadCount: 1,
        })
      );
    }
  }
);

export const handleSocketContactData = createAsyncThunk(
  'messages/handleSocketContactData',
  async ({ userId, contactData }, { dispatch }) => {
    if (!isValidObjectId(contactData.id)) {
      console.warn('Invalid contact data:', contactData);
      return;
    }
    dispatch(addContact(contactData));
  }
);

export const handleSocketUserStatus = createAsyncThunk(
  'messages/handleSocketUserStatus',
  async ({ userId, status, lastSeen }, { dispatch }) => {
    if (!isValidObjectId(userId)) {
      console.warn('Invalid user status:', { userId, status });
      return;
    }
    dispatch(updateContactStatus({ userId, status, lastSeen }));
  }
);

export const handleSocketUserDeleted = createAsyncThunk(
  'messages/handleSocketUserDeleted',
  async ({ userId }, { dispatch }) => {
    if (!isValidObjectId(userId)) {
      console.warn('Invalid user deleted:', userId);
      return;
    }
    dispatch(removeContact(userId));
  }
);

export const {
  setMessages,
  addMessage,
  replaceMessage,
  updateMessageStatus,
  deleteMessage,
  setSelectedChat,
  setChatList,
  addContact,
  updateContactStatus,
  removeContact,
  setMessagesError,
  resetState,
} = messageSlice.actions;

export const { setAuth, clearAuthData, setAuthError } = authSlice.actions;

// Persistence Middleware
const persistenceMiddleware = (store) => (next) => (action) => {
  const result = next(action);
  const actionsToPersist = [
    setSelectedChat.type,
    resetState.type,
    setAuth.type,
    clearAuthData.type,
    setChatList.type,
    addContact.type,
    removeContact.type,
  ];

  if (actionsToPersist.includes(action.type)) {
    requestAnimationFrame(() => {
      const state = store.getState();
      try {
        const serializableState = {
          messages: {
            selectedChat: state.messages.selectedChat,
            chatList: state.messages.chatList.map((contact) => ({
              ...contact,
              latestMessage: contact.latestMessage
                ? {
                    ...contact.latestMessage,
                    createdAt: contact.latestMessage.createdAt || new Date().toISOString(),
                  }
                : null,
            })),
          },
          auth: {
            userId: state.auth.userId,
            role: state.auth.role,
            photo: state.auth.photo,
            virtualNumber: state.auth.virtualNumber,
            username: state.auth.username,
          },
        };
        localStorage.setItem('reduxState', JSON.stringify(serializableState));
        console.log('Persisted state:', {
          selectedChat: state.messages.selectedChat,
          chatListCount: state.messages.chatList.length,
          userId: state.auth.userId,
        });
      } catch (error) {
        console.error('Failed to persist state:', error);
        dispatch(setMessagesError('Failed to save state'));
        localStorage.removeItem('reduxState');
      }
    });
  }

  return result;
};

// Load Persisted State
const loadPersistedState = () => {
  try {
    const persistedState = localStorage.getItem('reduxState');
    if (persistedState) {
      const parsedState = JSON.parse(persistedState);
      if (
        parsedState &&
        parsedState.messages &&
        (isValidObjectId(parsedState.messages.selectedChat) || parsedState.messages.selectedChat === null) &&
        Array.isArray(parsedState.messages.chatList) &&
        parsedState.auth
      ) {
        console.log('Loaded persisted state:', {
          selectedChat: parsedState.messages.selectedChat,
          chatListCount: parsedState.messages.chatList.length,
          userId: parsedState.auth.userId,
        });
        return {
          messages: {
            selectedChat: parsedState.messages.selectedChat,
            chatList: parsedState.messages.chatList.map((contact) => ({
              ...contact,
              id: String(contact.id),
              latestMessage: contact.latestMessage
                ? {
                    ...contact.latestMessage,
                    _id: String(contact.latestMessage._id),
                    senderId: String(contact.latestMessage.senderId),
                    recipientId: String(contact.latestMessage.recipientId),
                    clientMessageId: String(contact.latestMessage.clientMessageId || contact.latestMessage._id),
                  }
                : null,
              unreadCount: Number.isFinite(contact.unreadCount) ? contact.unreadCount : 0,
            })),
            chats: {},
            error: null,
          },
          auth: {
            token: null, // Load token from App.js
            userId: parsedState.auth.userId || null,
            role: parsedState.auth.role || null,
            photo: parsedState.auth.photo || null,
            virtualNumber: parsedState.auth.virtualNumber || null,
            username: parsedState.auth.username || null,
            privateKey: null,
            error: null,
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

// Configure Store
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
        ignoredActions: [
          setMessages.type,
          addMessage.type,
          replaceMessage.type,
          updateMessageStatus.type,
          deleteMessage.type,
          setChatList.type,
          addContact.type,
          updateContactStatus.type,
          removeContact.type,
          setAuth.type,
          handleSocketMessage.type,
          handleSocketContactData.type,
          handleSocketUserStatus.type,
          handleSocketUserDeleted.type,
        ],
        ignoredPaths: ['messages.chats', 'messages.chatList', 'auth'],
      },
    }).concat(persistenceMiddleware),
});