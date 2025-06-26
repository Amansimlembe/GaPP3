import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import axios from 'axios';
import forge from 'node-forge';
import { FaArrowLeft, FaEllipsisV, FaPaperclip, FaSmile, FaPaperPlane, FaTimes, FaSignOutAlt, FaPlus, FaImage, FaVideo, FaFile, FaMusic } from 'react-icons/fa';
import { motion, AnimatePresence } from 'framer-motion';
import Picker from 'emoji-picker-react';
import { VariableSizeList } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { setMessages, addMessage, replaceMessage, updateMessageStatus, setSelectedChat, setChatList } from '../store';
import PropTypes from 'prop-types';
import '../index.css';

const BASE_URL = 'https://gapp-6yc3.onrender.com';
const CACHE_TIMEOUT = 5 * 60 * 1000;

const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);
const isValidVirtualNumber = (number) => /^\+\d{7,15}$/.test(number.trim());
const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

const ChatScreen = React.memo(({ token, userId, socket, username, virtualNumber, photo, onLogout, theme }) => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { selectedChat, chats, chatList, chatListTimestamp } = useSelector((state) => state.messages);
  const [message, setMessage] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [contactInput, setContactInput] = useState('');
  const [contactError, setContactError] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAttachmentPicker, setShowAttachmentPicker] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [unreadMessages, setUnreadMessages] = useState({});
  const [isForgeReady, setIsForgeReady] = useState(false);
  const [isLoadingAddContact, setIsLoadingAddContact] = useState(false);
  const [isLoadingChatList, setIsLoadingChatList] = useState(false);
  const [file, setFile] = useState(null);
  const [fetchStatus, setFetchStatus] = useState('idle');
  const [fetchError, setFetchError] = useState(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const listRef = useRef(null);
  const menuRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const typingDebounceRef = useRef(null);
  const sentStatusesRef = useRef(new Set());
  const isMountedRef = useRef(true);
  const retryCountRef = useRef({ chatList: 0, addContact: 0 });
  const retryTimeoutRef = useRef({ chatList: null, addContact: null });
  const errorLogTimestamps = useRef(new Map());
  const forgeInitAttemptsRef = useRef(0);
  const maxForgeInitAttempts = 3;

  const throttle = useCallback((func, limit) => {
    let lastFunc;
    let lastRan;
    return (...args) => {
      if (!lastRan) {
        func(...args);
        lastRan = Date.now();
      } else {
        clearTimeout(lastFunc);
        lastFunc = setTimeout(() => {
          if (Date.now() - lastRan >= limit) {
            func(...args);
            lastRan = Date.now();
          }
        }, limit - (Date.now() - lastRan));
      }
    };
  }, []);

  const debounce = useCallback((func, wait) => {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }, []);


  const logClientError = useCallback(async (message, error) => {
  const now = Date.now();
  const errorEntry = errorLogTimestamps.current.get(message) || { count: 0, timestamps: [] };
  errorEntry.timestamps = errorEntry.timestamps.filter((ts) => now - ts < 60 * 1000);
  if (errorEntry.count >= 1 || errorEntry.timestamps.length >= 1) {
    console.log(`Client error logging skipped for "${message}": rate limit reached`);
    return;
  }
  // Only log critical errors
  const isCritical = message.includes('Unauthorized') || message.includes('failed after max retries') || message.includes('Forge init failed');
  if (!isCritical) {
    console.log(`Non-critical client error suppressed: ${message}`);
    return;
  }
  errorEntry.count += 1;
  errorEntry.timestamps.push(now);
  errorLogTimestamps.current.set(message, errorEntry);

  try {
    await axios.post(
      `${BASE_URL}/social/log-error`,
      {
        error: message,
        stack: error?.stack || '',
        userId,
        route: window.location.pathname,
        timestamp: new Date().toISOString(),
      },
      { timeout: 5000 }
    );
    console.log(`Critical client error logged: ${message}`);
  } catch (err) {
    console.error('Failed to log client error:', err.message);
  }
}, [userId]);






  useEffect(() => {
    const initializeForge = async () => {
      if (forgeInitAttemptsRef.current >= maxForgeInitAttempts) {
        console.error('Max forge initialization attempts reached');
        logClientError('Max forge initialization attempts reached', new Error('Forge init failed'));
        setIsForgeReady(true); // Proceed to avoid blocking
        return;
      }
      forgeInitAttemptsRef.current += 1;
      if (forge?.random && forge?.pki && forge?.cipher) {
        setIsForgeReady(true);
        console.log('Forge initialized successfully');
      } else {
        console.warn('Forge not ready, retrying...');
        await new Promise((resolve) => setTimeout(resolve, 1000 * forgeInitAttemptsRef.current));
        initializeForge();
      }
    };
    initializeForge();
  }, [logClientError]);

  const getPublicKey = useCallback(async (recipientId) => {
    if (!isValidObjectId(recipientId)) throw new Error('Invalid recipientId');
    const cacheKey = `publicKey:${recipientId}`;
    const cachedKey = sessionStorage.getItem(cacheKey);
    if (cachedKey) return cachedKey;
    try {
      const { data } = await axios.get(`${BASE_URL}/auth/public_key/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });
      if (!data.publicKey) throw new Error('No public key returned');
      sessionStorage.setItem(cacheKey, data.publicKey);
      return data.publicKey;
    } catch (err) {
      console.error('Failed to fetch public key:', err.message);
      if (err.response?.status === 401) {
        logClientError('Public key fetch failed: Unauthorized', err);
        setTimeout(() => onLogout(), 1000);
      }
      throw new Error('Failed to fetch public key');
    }
  }, [token, onLogout, logClientError]);

  const encryptMessage = useCallback(async (content, recipientPublicKey, isMedia = false) => {
    if (!isForgeReady || !recipientPublicKey) {
      const err = new Error('Encryption dependencies missing');
      logClientError('Encryption dependencies missing', err);
      throw err;
    }
    try {
      const aesKey = forge.random.getBytesSync(32);
      const iv = forge.random.getBytesSync(16);
      const cipher = forge.cipher.createCipher('AES-CBC', aesKey);
      cipher.start({ iv });
      cipher.update(forge.util.createBuffer(isMedia ? content : forge.util.encodeUtf8(content)));
      cipher.finish();
      const encrypted = `${forge.util.encode64(cipher.output.getBytes())}|${forge.util.encode64(iv)}|${forge.util.encode64(
        forge.pki.publicKeyFromPem(recipientPublicKey).encrypt(aesKey, 'RSA-OAEP', { md: forge.md.sha256.create() })
      )}`;
      return encrypted;
    } catch (err) {
      console.error('Encryption failed:', err.message);
      throw new Error('Failed to encrypt message');
    }
  }, [isForgeReady, logClientError]);



const fetchChatList = useCallback(
  debounce(
    async (force = false) => {
      if (!isMountedRef.current) {
        console.log('fetchChatList aborted: component unmounted');
        return;
      }
      // Instantly use cached contacts if available
      if (!force && chatList.length && chatListTimestamp && Date.now() - chatListTimestamp < CACHE_TIMEOUT) {
        console.log('fetchChatList: Using cached contacts instantly');
        setFetchStatus('cached');
        setFetchError(null);
        setIsLoadingChatList(false);
        return;
      }
      if (!navigator.onLine && !force) {
        console.log('fetchChatList: Device offline, using cached contacts');
        setFetchStatus('cached');
        setFetchError('You are offline. Displaying cached contacts.');
        setIsLoadingChatList(false);
        return;
      }
      if (!isForgeReady) {
        console.log('fetchChatList deferred: forge not ready');
        setFetchStatus('loading');
        setIsLoadingChatList(true);
        return;
      }
      const fetchId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      console.log(`fetchChatList started with fetchId: ${fetchId}`);
      setIsLoadingChatList(true);
      setFetchStatus('loading');
      let retryCount = retryCountRef.current.chatList;
      const maxRetries = 3;
      const baseDelay = 3000;

      const attemptFetch = async () => {
        try {
          const { data } = await axios.get(`${BASE_URL}/social/chat-list`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { userId },
            timeout: 10000,
          });
          console.log('fetchChatList response:', { fetchId, dataLength: data.length });
          if (!Array.isArray(data)) {
            throw new Error('Invalid chat list data: not an array');
          }
          if (isMountedRef.current && fetchId === fetchChatList.currentFetchId) {
            const validChats = data.filter((chat) => isValidObjectId(chat.id));
            if (validChats.length > 0) {
              const updatedChatList = validChats.map((chat) => ({
                ...chat,
                _id: chat.id,
                unreadCount: unreadMessages[chat.id] || chat.unreadCount || 0,
                lastSeen: chat.lastSeen ? new Date(chat.lastSeen).toISOString() : null,
                latestMessage: chat.latestMessage
                  ? {
                      ...chat.latestMessage,
                      createdAt: chat.latestMessage.createdAt
                        ? new Date(chat.latestMessage.createdAt).toISOString()
                        : new Date().toISOString(),
                      updatedAt: chat.latestMessage.updatedAt
                        ? new Date(chat.latestMessage.updatedAt).toISOString()
                        : undefined,
                    }
                  : null,
              }));
              console.log(`fetchChatList updating state with ${updatedChatList.length} chats`);
              dispatch(setChatList(updatedChatList));
              setFetchStatus('success');
              setFetchError(null);
            } else {
              console.warn('fetchChatList: No valid chats in response, retaining existing chatList');
              setFetchStatus('success');
              setFetchError(null);
            }
            retryCountRef.current.chatList = 0;
            clearTimeout(retryTimeoutRef.current.chatList);
          }
        } catch (err) {
          if (!isMountedRef.current || fetchId !== fetchChatList.currentFetchId) {
            console.log(`fetchChatList aborted for fetchId: ${fetchId}`);
            return;
          }
          if (err.response?.status === 401) {
            console.error('fetchChatList unauthorized:', err.message);
            logClientError('Chat list fetch failed: Unauthorized', err);
            setTimeout(() => onLogout(), 1000);
            return;
          }
          if (retryCount < maxRetries) {
            retryCount += 1;
            retryCountRef.current.chatList = retryCount;
            const delay = baseDelay * Math.pow(2, retryCount) * (1 + Math.random() * 0.1);
            console.warn(`fetchChatList attempt ${retryCount} failed: ${err.message}, retrying in ${delay}ms`);
            clearTimeout(retryTimeoutRef.current.chatList);
            retryTimeoutRef.current.chatList = setTimeout(attemptFetch, delay);
          } else {
            console.error('fetchChatList failed after max retries:', err.message);
            setFetchStatus('error');
            setFetchError('Failed to load contacts, please try again');
            logClientError('Chat list fetch failed after max retries', err);
            retryCountRef.current.chatList = 0;
            clearTimeout(retryTimeoutRef.current.chatList);
          }
        } finally {
          if (isMountedRef.current && fetchId === fetchChatList.currentFetchId) {
            console.log(`fetchChatList completed for fetchId: ${fetchId}`);
            setIsLoadingChatList(false);
          }
        }
      };

      fetchChatList.currentFetchId = fetchId;
      await attemptFetch();
    },
    1000,
    { leading: false, trailing: true }
  ),
  [isForgeReady, token, userId, onLogout, unreadMessages, logClientError, dispatch, chatList, chatListTimestamp]
);
fetchChatList.cancel = () => debounce.cancel();


useEffect(() => {
  isMountedRef.current = true;
  if (!token || !userId) {
    console.error('Missing token or userId, redirecting to login');
    navigate('/login', { replace: true });
    return () => {};
  }
  console.log('Initial fetchChatList setup');
  // Instantly populate cached contacts if available
  if (chatList.length && chatListTimestamp && Date.now() - chatListTimestamp < CACHE_TIMEOUT) {
    console.log('Initial setup: Using cached contacts instantly');
    setFetchStatus('cached');
    setFetchError(null);
    setIsLoadingChatList(false);
  } else {
    fetchChatList();
  }
  const handleSocketConnect = () => {
    if (socket && isMountedRef.current) {
      socket.emit('join', userId);
    }
  };
  if (socket) {
    socket.on('connect', handleSocketConnect);
    if (socket.connected) {
      socket.emit('join', userId);
    }
  }
  const handleOffline = () => {
    console.log('Network offline, displaying cached contacts');
    setFetchError('You are offline. Displaying cached contacts.');
    setFetchStatus('cached');
    setIsLoadingChatList(false);
  };
  window.addEventListener('offline', handleOffline);
  return () => {
    console.log('Cleaning up initial fetch effect');
    isMountedRef.current = false;
    clearTimeout(retryTimeoutRef.current.chatList);
    clearTimeout(retryTimeoutRef.current.addContact);
    sentStatusesRef.current.clear();
    errorLogTimestamps.current.clear();
    if (socket) {
      socket.off('connect', handleSocketConnect);
    }
    window.removeEventListener('offline', handleOffline);
  };
}, [token, userId, socket, navigate, fetchChatList, chatList, chatListTimestamp]);



const handleAddContact = useCallback(async () => {
  const maxRetries = 3;
  if (!contactInput.trim()) {
    setContactError('Please enter a virtual number');
    return;
  }
  if (!isValidVirtualNumber(contactInput)) {
    setContactError('Invalid virtual number format (e.g., +1234567890)');
    return;
  }
  setIsLoadingAddContact(true);
  let retryCount = retryCountRef.current.addContact;
  if (retryCount > maxRetries) {
    setContactError('Max retries exceeded');
    setIsLoadingAddContact(false);
    retryCountRef.current.addContact = 0;
    return;
  }
  try {
    const response = await axios.post(
      `${BASE_URL}/social/add_contact`,
      { userId, virtualNumber: contactInput.trim() },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
    );
    if (!isMountedRef.current) return;
    const newChat = {
      id: response.data.id,
      _id: response.data.id,
      username: response.data.username || 'Unknown',
      virtualNumber: response.data.virtualNumber || '',
      photo: response.data.photo || 'https://placehold.co/40x40',
      status: response.data.status || 'offline',
      lastSeen: response.data.lastSeen ? new Date(response.data.lastSeen).toISOString() : null,
      latestMessage: null,
      unreadCount: 0,
    };
    // Update chatList instantly and persist
    dispatch(setChatList((prev) => {
      if (prev.find((chat) => chat.id === newChat.id)) return prev;
      const updatedChatList = [...prev, newChat];
      // Persist updated chatList immediately
      const state = store.getState();
      const serializableState = {
        messages: {
          selectedChat: state.messages.selectedChat,
          chats: state.messages.chats,
          chatList: updatedChatList,
          chatListTimestamp: Date.now(),
          messagesTimestamp: state.messages.messagesTimestamp,
          chatMessageCount: state.messages.chatMessageCount,
        },
        auth: state.auth,
      };
      initDB().then((db) => {
        db.put(STORE_NAME, { key: 'state', value: serializableState })
          .then(() => console.log(`handleAddContact: Persisted updated chatList with ${updatedChatList.length} contacts`))
          .catch((error) => logClientError('Failed to persist chatList after adding contact', error));
      });
      return updatedChatList;
    }));
    setContactInput('');
    setContactError('');
    setShowAddContact(false);
    retryCountRef.current.addContact = 0;
    clearTimeout(retryTimeoutRef.current.addContact);
    // No need to call fetchChatList since chatList is updated instantly
  } catch (err) {
    console.error('Add contact failed:', err.message);
    if (!isMountedRef.current) return;
    const errorMsg = err.response?.data?.error || 'Failed to add contact';
    if ((err.code === 'ECONNABORTED' || err.response?.status === 429 || err.response?.status === 503) && retryCount < maxRetries) {
      retryCount += 1;
      retryCountRef.current.addContact = retryCount;
      const delay = err.response?.status === 429 ? 60000 : 1000 * Math.pow(2, retryCount);
      clearTimeout(retryTimeoutRef.current.addContact);
      retryTimeoutRef.current.addContact = setTimeout(handleAddContact, delay);
    } else {
      setContactError(errorMsg);
      retryCountRef.current.addContact = 0;
      clearTimeout(retryTimeoutRef.current.addContact);
      if (err.response?.status === 401) {
        logClientError('Add contact failed: Unauthorized', err);
        setTimeout(() => onLogout(), 1000);
      }
    }
  } finally {
    if (isMountedRef.current) setIsLoadingAddContact(false);
  }
}, [contactInput, token, userId, onLogout, logClientError, dispatch]);





  const fetchMessages = useCallback(async (chatId) => {
    if (!isForgeReady || !isValidObjectId(chatId) || !isMountedRef.current) return;
    try {
      const { data } = await axios.get(`${BASE_URL}/social/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, recipientId: chatId },
        timeout: 10000,
      });
      if (!Array.isArray(data.messages)) {
        throw new Error('Invalid messages data: not an array');
      }
      if (isMountedRef.current) {
        dispatch(setMessages({ recipientId: chatId, messages: data.messages }));
        setUnreadMessages((prev) => ({ ...prev, [chatId]: 0 }));
      }
      const unreadMessageIds = data.messages
        .filter((m) => m.status !== 'read' && m.recipientId.toString() === userId && !sentStatusesRef.current.has(m._id))
        .map((m) => m._id);
      if (unreadMessageIds.length && socket) {
        socket.emit('batchMessageStatus', {
          messageIds: unreadMessageIds,
          status: 'read',
          recipientId: userId,
        });
        unreadMessageIds.forEach((id) => sentStatusesRef.current.add(id));
      }
      listRef.current?.scrollToItem(data.messages.length, 'end');
    } catch (err) {
      console.error('Messages fetch failed:', err.message);
      if (err.response?.status === 401) {
        logClientError('Messages fetch failed: Unauthorized', err);
        setTimeout(() => onLogout(), 1000);
      }
    }
  }, [isForgeReady, token, userId, socket, dispatch, logClientError, onLogout]);

  const sendMessage = useCallback(async (retryCount = 0) => {
    if (!isForgeReady || !message.trim() || !selectedChat || !isValidObjectId(selectedChat)) return;
    const clientMessageId = generateClientMessageId();
    const plaintextContent = message.trim();
    const maxMessageRetries = 3;

    const attemptSend = async () => {
      try {
        const recipientPublicKey = await getPublicKey(selectedChat);
        const encryptedContent = await encryptMessage(plaintextContent, recipientPublicKey);
        const messageData = {
          senderId: userId,
          recipientId: selectedChat,
          content: encryptedContent,
          contentType: 'text',
          plaintextContent,
          clientMessageId,
          senderVirtualNumber: virtualNumber,
          senderUsername: username,
          senderPhoto: photo,
          _id: clientMessageId,
          status: 'pending',
          createdAt: new Date(),
        };
        dispatch(addMessage({ recipientId: selectedChat, message: messageData }));
        socket?.emit('message', messageData, (ack) => {
          if (ack?.error) {
            console.error('Socket message failed:', ack.error);
            dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
            return;
          }
          dispatch(replaceMessage({ recipientId: selectedChat, message: { ...ack.message, plaintextContent }, replaceId: clientMessageId }));
          dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: ack.message._id, status: 'sent' }));
        });
        setMessage('');
        inputRef.current?.focus();
        listRef.current?.scrollToItem((chats[selectedChat]?.length || 0) + 1, 'end');
      } catch (err) {
        console.error('Send message failed:', err.message);
        const isNonTransient = err.response?.status >= 400 && err.response?.status < 500 && err.response?.status !== 429;
        if (isNonTransient || retryCount >= maxMessageRetries) {
          dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
          logClientError(`Send message failed after ${retryCount} retries`, err);
          return;
        }
        const delay = Math.pow(2, retryCount) * 1000;
        setTimeout(() => sendMessage(retryCount + 1), delay);
      }
    };

    await attemptSend();
  }, [isForgeReady, message, selectedChat, userId, virtualNumber, username, photo, socket, getPublicKey, encryptMessage, dispatch, chats, logClientError]);

  const handleAttachment = useCallback(async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile || !selectedChat || !isValidObjectId(selectedChat)) return;
    if (selectedFile.size > 50 * 1024 * 1024) {
      console.error('File size exceeds 50MB limit');
      return;
    }
    setFile(selectedFile);
    setShowAttachmentPicker(false);
    const clientMessageId = generateClientMessageId();
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('userId', userId);
      formData.append('recipientId', selectedChat);
      formData.append('clientMessageId', clientMessageId);
      formData.append('senderVirtualNumber', virtualNumber);
      formData.append('senderUsername', username);
      formData.append('senderPhoto', photo);
      const tempMessage = {
        senderId: userId,
        recipientId: selectedChat,
        content: URL.createObjectURL(selectedFile),
        contentType: selectedFile.type.startsWith('image/') ? 'image' :
                     selectedFile.type.startsWith('video/') ? 'video' :
                     selectedFile.type.startsWith('audio/') ? 'audio' : 'document',
        originalFilename: selectedFile.name,
        clientMessageId,
        status: 'pending',
        createdAt: new Date(),
      };
      dispatch(addMessage({ recipientId: selectedChat, message: tempMessage }));
      const { data } = await axios.post(`${BASE_URL}/social/upload`, formData, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
        timeout: 30000,
      });
      dispatch(replaceMessage({ recipientId: selectedChat, message: data.message, replaceId: clientMessageId }));
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: data.message._id, status: 'sent' }));
      setFile(null);
      listRef.current?.scrollToItem((chats[selectedChat]?.length || 0) + 1, 'end');
    } catch (err) {
      console.error('File upload failed:', err.message);
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
    }
  }, [selectedChat, userId, virtualNumber, username, photo, token, dispatch, chats]);

  useEffect(() => {
    const maxStatuses = 1000;
    const lruCache = new Map();

    const addToCache = (id) => {
      if (lruCache.size >= maxStatuses) {
        const firstKey = lruCache.keys().next().value;
        lruCache.delete(firstKey);
      }
      lruCache.set(id, true);
    };

    sentStatusesRef.current = {
      add: (id) => addToCache(id),
      has: (id) => lruCache.has(id),
      clear: () => lruCache.clear(),
    };
  }, []);

  useEffect(() => {
    if (!socket || !isForgeReady || !userId) return () => {};

    let statusUpdateQueue = [];
    let statusUpdateTimeout = null;
    let lastChatListUpdate = 0;

    const flushStatusUpdates = () => {
      if (statusUpdateQueue.length) {
        socket.emit('batchMessageStatus', {
          messageIds: statusUpdateQueue,
          status: 'read',
          recipientId: userId,
        });
        statusUpdateQueue.forEach((id) => sentStatusesRef.current.add(id));
        statusUpdateQueue = [];
      }
    };



    const handleNewContact = ({ contactData }) => {
  if (!contactData?.id || !isValidObjectId(contactData.id) || !contactData.virtualNumber) {
    console.error('Invalid contactData received:', contactData);
    return;
  }
  dispatch(setChatList((prev) => {
    if (prev.find((chat) => chat.id === contactData.id)) {
      console.log(`handleNewContact: Contact ${contactData.id} already exists in chatList`);
      return prev;
    }
    const newContact = {
      id: contactData.id,
      _id: contactData.id,
      username: contactData.username || 'Unknown',
      virtualNumber: contactData.virtualNumber || '',
      photo: contactData.photo || 'https://placehold.co/40x40',
      status: contactData.status || 'offline',
      lastSeen: contactData.lastSeen ? new Date(contactData.lastSeen).toISOString() : null,
      latestMessage: null,
      unreadCount: 0,
    };
    const updatedChatList = [...prev, newContact];
    console.log(`handleNewContact: Added contact ${contactData.id} to chatList, new length: ${updatedChatList.length}`);
    return updatedChatList;
  }));
};




const handleChatListUpdated = ({ users, page = 0, limit = 50 }) => {
  const now = Date.now();
  if (now - lastChatListUpdate < 500) {
    console.log('chatListUpdated debounced');
    return;
  }
  lastChatListUpdate = now;
  if (!Array.isArray(users) || users.length === 0) {
    console.warn('chatListUpdated received empty or invalid users data:', users);
    return;
  }
  console.log(`chatListUpdated processing ${users.length} users for userId ${userId}`);
  const validUsers = users.filter((chat) => isValidObjectId(chat.id));
  if (validUsers.length > 0) {
    dispatch(setChatList(validUsers));
  } else {
    console.warn('chatListUpdated: No valid users to update');
  }
};



    const handleMessage = (msg) => {
      if (!isMountedRef.current) return;
      const senderId = typeof msg.senderId === 'object' ? msg.senderId._id.toString() : msg.senderId.toString();
      const recipientId = typeof msg.recipientId === 'object' ? msg.recipientId._id.toString() : msg.recipientId.toString();
      const targetId = senderId === userId ? recipientId : senderId;
      dispatch(addMessage({ recipientId: targetId, message: msg }));
      if (selectedChat === targetId && document.hasFocus()) {
        if (!sentStatusesRef.current.has(msg._id)) {
          statusUpdateQueue.push(msg._id);
          clearTimeout(statusUpdateTimeout);
          statusUpdateTimeout = setTimeout(flushStatusUpdates, 500);
        }
        setUnreadMessages((prev) => ({ ...prev, [targetId]: 0 }));
        listRef.current?.scrollToItem((chats[targetId]?.length || 0) + 1, 'end');
      } else {
        setUnreadMessages((prev) => ({ ...prev, [targetId]: (prev[targetId] || 0) + 1 }));
      }
    };

    const handleTyping = ({ userId: typingUserId }) => {
      if (typingUserId === selectedChat && isMountedRef.current) {
        setIsTyping((prev) => ({ ...prev, [typingUserId]: true }));
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
          setIsTyping((prev) => ({ ...prev, [typingUserId]: false }));
        }, 3000);
      }
    };

    const handleStopTyping = ({ userId: typingUserId }) => {
      if (typingUserId === selectedChat && isMountedRef.current) {
        setIsTyping((prev) => ({ ...prev, [typingUserId]: false }));
      }
    };

    const handleMessageStatus = ({ messageIds, status }) => {
      if (!isMountedRef.current) return;
      messageIds.forEach((messageId) => {
        Object.keys(chats).forEach((chatId) => {
          if (chats[chatId].some((msg) => msg._id === messageId && msg.senderId.toString() === userId)) {
            dispatch(updateMessageStatus({ recipientId: chatId, messageId, status }));
          }
        });
      });
    };

    socket.on('contactData', handleNewContact);
    socket.on('chatListUpdated', handleChatListUpdated);
    socket.on('message', handleMessage);
    socket.on('typing', handleTyping);
    socket.on('stopTyping', handleStopTyping);
    socket.on('messageStatus', handleMessageStatus);

    return () => {
      socket.off('contactData', handleNewContact);
      socket.off('chatListUpdated', handleChatListUpdated);
      socket.off('message', handleMessage);
      socket.off('typing', handleTyping);
      socket.off('stopTyping', handleStopTyping);
      socket.off('messageStatus', handleMessageStatus);
      clearTimeout(typingTimeoutRef.current);
      clearTimeout(typingDebounceRef.current);
      clearTimeout(retryTimeoutRef.current.chatList);
      clearTimeout(retryTimeoutRef.current.addContact);
      clearTimeout(statusUpdateTimeout);
      flushStatusUpdates();
      setUnreadMessages({});
      setIsTyping({});
    };
  }, [socket, isForgeReady, selectedChat, userId, chats, dispatch, unreadMessages]);

  useEffect(() => {
    if (selectedChat && !chats[selectedChat]) {
      fetchMessages(selectedChat);
    }
  }, [selectedChat, fetchMessages, chats]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowMenu(false);
        setShowAddContact(false);
        setShowAttachmentPicker(false);
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      setShowMenu(false);
      setShowAddContact(false);
      setShowAttachmentPicker(false);
      setShowEmojiPicker(false);
    };
  }, []);

  const throttledEmit = useMemo(() => throttle((event, data) => socket?.emit(event, data), 500), [socket, throttle]);

  const handleTyping = useCallback(() => {
    if (!socket || !selectedChat) return;
    clearTimeout(typingDebounceRef.current);
    typingDebounceRef.current = setTimeout(() => {
      throttledEmit('typing', { userId, recipientId: selectedChat });
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        throttledEmit('stopTyping', { userId, recipientId: selectedChat });
      }, 3000);
    }, 500);
  }, [socket, selectedChat, userId, throttledEmit]);

  const selectChat = useCallback((chatId) => {
    dispatch(setSelectedChat(chatId));
    setShowMenu(false);
    if (chatId && socket) {
      const unreadMessageIds = (chats[chatId] || [])
        .filter((m) => m.status !== 'read' && m.recipientId.toString() === userId && !sentStatusesRef.current.has(m._id))
        .map((m) => m._id);
      if (unreadMessageIds.length) {
        socket.emit('batchMessageStatus', {
          messageIds: unreadMessageIds,
          status: 'read',
          recipientId: userId,
        });
        unreadMessageIds.forEach((id) => sentStatusesRef.current.add(id));
      }
      setUnreadMessages((prev) => ({ ...prev, [chatId]: 0 }));
    }
    inputRef.current?.focus();
  }, [socket, chats, userId, dispatch]);

  const getItemSize = (index) => {
    const msg = chats[selectedChat]?.[index];
    if (!msg) return 60;
    const isMedia = ['image', 'video', 'audio', 'document'].includes(msg.contentType);
    const baseHeight = 60;
    const mediaHeight = isMedia ? 150 : 0;
    const captionHeight = msg.caption ? 20 : 0;
    return baseHeight + mediaHeight + captionHeight;
  };

  const Row = useCallback(
    ({ index, style }) => {
      const msg = chats[selectedChat]?.[index];
      if (!msg) return null;
      const prevMsg = index > 0 ? chats[selectedChat][index - 1] : null;
      const showDate = !prevMsg || new Date(msg.createdAt).toDateString() !== new Date(prevMsg.createdAt).toDateString();
      const isMine = msg.senderId.toString() === userId;

      return (
        <>
          {showDate && (
            <div className="flex justify-center my-2">
              <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded">
                {new Date(msg.createdAt).toLocaleDateString()}
              </span>
            </div>
          )}
          <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} px-4`} style={style}>
            <div
              className={`max-w-[70%] rounded-lg p-3 ${
                isMine ? 'bg-blue-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
              }`}
            >
              {msg.contentType === 'text' ? (
                <p>{msg.plaintextContent || '[Message not decrypted]'}</p>
              ) : (
                <>
                  {msg.contentType === 'image' && (
                    <img src={msg.content} alt="media" className="max-w-full h-auto rounded" />
                  )}
                  {msg.contentType === 'video' && (
                    <video src={msg.content} controls className="max-w-full h-auto rounded" />
                  )}
                  {msg.contentType === 'audio' && (
                    <audio src={msg.content} controls className="w-full" />
                  )}
                  {msg.contentType === 'document' && (
                    <a
                      href={msg.content}
                      className="text-blue-500 dark:text-blue-400 underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {msg.originalFilename || 'Document'}
                    </a>
                  )}
                  {msg.caption && <p className="mt-1 text-sm">{msg.caption}</p>}
                </>
              )}
              <div className="flex justify-between items-center mt-1 text-xs">
                <span className={isMine ? 'text-white' : 'text-gray-500 dark:text-gray-400'}>
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {isMine && (
                  <span className="ml-2">
                    {msg.status === 'pending' ? 'o' : msg.status === 'sent' ? '✓' : msg.status === 'delivered' ? '✓✓' : '👀'}
                  </span>
                )}
              </div>
            </div>
          </div>
        </>
      );
    },
    [chats, selectedChat, userId, theme]
  );

  return (
    <div className={`min-h-screen flex flex-col bg-gray-100 dark:bg-gray-900 ${theme === 'dark' ? 'dark' : ''}`}>
      <div className="flex justify-between items-center p-4 bg-blue-500 dark:bg-gray-800 text-white dark:text-gray-200">
        <h1 className="text-xl font-bold">Gian Chat</h1>
        <div className="relative">
          <FaEllipsisV className="cursor-pointer" onClick={() => setShowMenu(!showMenu)} />
          <AnimatePresence>
            {showMenu && (
              <motion.div
                ref={menuRef}
                className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg z-10"
                initial={{ opacity: 0, y: 0 }}
                animate={{ opacity: 1, y: 10 }}
                exit={{ opacity: 0, y: 0 }}
                transition={{ duration: 0.2 }}
              >
                <button
                  className="flex items-center w-full px-4 py-2 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                  onClick={() => {
                    setShowAddContact(true);
                    setShowMenu(true);
                  }}
                >
                  <FaPlus className="mr-2" />
                  Add Contact
                </button>
                <button
                  className="flex items-center w-full px-4 py-2 text-red-500 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                  onClick={onLogout}
                >
                  <FaSignOutAlt className="mr-2" />
                  Logout
                </button>
                {showAddContact && (
                  <div className="p-4 bg-white dark:bg-gray-800 rounded-b-lg">
                    <div className="relative">
                      <input
                        type="text"
                        className={`w-full p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-gray-300 ${
                          contactError ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'
                        } bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100`}
                        value={contactInput}
                        onChange={(e) => setContactInput(e.target.value)}
                        placeholder="Enter virtual number (e.g., +1234567890)"
                        disabled={isLoadingAddContact}
                      />
                      {contactInput && (
                        <FaTimes
                          className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-500 dark:text-gray-400 cursor-pointer"
                          onClick={() => setContactInput('')}
                        />
                      )}
                    </div>
                    {contactError && <p className="text-red-500 dark:text-red-400 text-sm mt-1">{contactError}</p>}
                    <button
                      className="mt-2 w-full bg-blue-500 dark:bg-gray-700 text-white dark:text-gray-200 px-4 py-2 rounded-lg hover:bg-blue-600 dark:hover:bg-gray-600 disabled:opacity-50"
                      onClick={handleAddContact}
                      disabled={!contactInput.trim() || isLoadingAddContact}
                    >
                      {isLoadingAddContact ? 'Adding...' : 'Add Contact'}
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <div className="flex flex-1 overflow-hidden">



        <div className={`w-full md:w-1/3 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 ${selectedChat ? 'hidden md:block' : 'block'}`}>
  {console.log('Rendering contact list:', { isLoadingChatList, fetchStatus, chatListLength: chatList.length })}
  {!isLoadingChatList && (fetchStatus === 'success' || fetchStatus === 'cached') && chatList.length === 0 && (
    <div className="p-4 text-center">
      <p className="text-gray-500 dark:text-gray-400">No contacts to display. Add a contact to start chatting!</p>
      <button
        className="mt-2 bg-blue-500 dark:bg-gray-700 text-white dark:text-gray-200 px-4 py-2 rounded-lg hover:bg-blue-600 dark:hover:bg-gray-600"
        onClick={() => {
          setShowAddContact(true);
          setShowMenu(true);
        }}
      >
        Add Contact
      </button>
    </div>
  )}
  {!isLoadingChatList && (fetchStatus === 'success' || fetchStatus === 'cached') && chatList.length > 0 && (
    chatList
      .filter((chat) => isValidObjectId(chat.id))
      .map((chat) => (
        <div
          key={chat.id}
          className={`flex items-center p-4 border-b border-gray-200 dark:border-gray-700 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 ${
            selectedChat === chat.id ? 'bg-blue-100 dark:bg-gray-600' : ''
          }`}
          onClick={() => selectChat(chat.id)}
        >
          <img
            src={chat.photo || 'https://placehold.co/40x40'}
            alt="chat-avatar"
            className="w-10 h-10 rounded-full mr-3"
          />
          <div className="flex-1">
            <div className="flex justify-between">
              <span className="font-semibold text-gray-900 dark:text-gray-100">{chat.username || 'Unknown'}</span>
              {chat.latestMessage && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {new Date(chat.latestMessage?.createdAt || chat.lastSeen || Date.now()).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
            </div>
            {chat.latestMessage && (
              <p className="text-sm text-gray-600 dark:text-gray-300 truncate">
                {chat.latestMessage.plaintextContent || `[${chat.latestMessage.contentType}]`}
              </p>
            )}
            {!!chat.unreadCount && (
              <span className="absolute right-4 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                {chat.unreadCount}
              </span>
            )}
          </div>
        </div>
      ))
  )}
  {!isLoadingChatList && fetchStatus === 'error' && (
    <div className="p-4 text-center">
      <p className="text-red-500 dark:text-red-400">{fetchError}</p>
    </div>
  )}
</div>
        <div className={`flex-1 flex flex-col ${selectedChat ? 'block' : 'hidden md:block'}`}>
          {selectedChat ? (
            <>
              <div className="flex items-center p-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <FaArrowLeft className="mr-3 cursor-pointer md:hidden text-gray-900 dark:text-gray-100" onClick={() => selectChat(null)} />
                <img
                  src={chatList.find((c) => c.id === selectedChat)?.photo || 'https://placehold.co/40x40'}
                  alt="chat-avatar-img"
                  className="w-10 h-10 rounded-full mr-3"
                />
                <div>
                  <h2 className="font-semibold text-gray-900 dark:text-gray-100">
                    {chatList.find((c) => c.id === selectedChat)?.username || ''}
                  </h2>
                  {isTyping[selectedChat] && <span className="text-sm text-gray-500 dark:text-gray-400">Typing...</span>}
                </div>
              </div>
              <div className="flex-1 overflow-hidden">
                {chats[selectedChat]?.length ? (
                  <AutoSizer>
                    {({ height, width }) => (
                      <VariableSizeList
                        ref={listRef}
                        height={height}
                        width={width}
                        itemCount={chats[selectedChat].length}
                        itemSize={getItemSize}
                        initialScrollOffset={chats[selectedChat].length * 60}
                      >
                        {Row}
                      </VariableSizeList>
                    )}
                  </AutoSizer>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">
                    <p>No messages yet</p>
                  </div>
                )}
              </div>
              <div className="p-4 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
                <div className="flex items-center space-x-2">
                  <FaSmile
                    className="text-gray-500 dark:text-gray-400 cursor-pointer"
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  />
                  {showEmojiPicker && (
                    <div className="absolute bottom-16">
                      <Picker
                        onEmojiClick={(emojiObject) => {
                          setMessage((prev) => prev + emojiObject.emoji);
                          setShowEmojiPicker(false);
                        }}
                      />
                    </div>
                  )}
                  <FaPaperclip
                    className="text-gray-500 dark:text-gray-400 cursor-pointer"
                    onClick={() => setShowAttachmentPicker(!showAttachmentPicker)}
                  />
                  {showAttachmentPicker && (
                    <div className="absolute bottom-16 flex space-x-2 bg-white dark:bg-gray-800 p-2 rounded-lg shadow-lg">
                      <label className="cursor-pointer text-gray-500 dark:text-gray-400">
                        <FaImage />
                        <input
                          id="attach-image"
                          type="file"
                          accept="image/*"
                          onChange={handleAttachment}
                          ref={fileInputRef}
                          style={{ display: 'none' }}
                        />
                      </label>
                      <label className="cursor-pointer text-gray-500 dark:text-gray-400">
                        <FaVideo />
                        <input
                          id="attach-video"
                          type="file"
                          accept="video/*"
                          onChange={handleAttachment}
                          style={{ display: 'none' }}
                        />
                      </label>
                      <label className="cursor-pointer text-gray-500 dark:text-gray-400">
                        <FaMusic />
                        <input
                          id="attach-audio"
                          type="file"
                          accept="audio/*"
                          onChange={handleAttachment}
                          style={{ display: 'none' }}
                        />
                      </label>
                      <label className="cursor-pointer text-gray-500 dark:text-gray-400">
                        <FaFile />
                        <input
                          id="attach-document"
                          type="file"
                          accept=".pdf,.doc,.docx,.txt"
                          onChange={handleAttachment}
                          style={{ display: 'none' }}
                        />
                      </label>
                    </div>
                  )}
                  <input
                    ref={inputRef}
                    type="text"
                    className="flex-1 p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-gray-300 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    onKeyUp={handleTyping}
                    placeholder="Type a message..."
                  />
                  <FaPaperPlane
                    className="text-blue-500 dark:text-gray-300 cursor-pointer"
                    onClick={sendMessage}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">
              <p>Select a chat to start messaging</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

ChatScreen.propTypes = {
  token: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  socket: PropTypes.object.isRequired,
  username: PropTypes.string,
  virtualNumber: PropTypes.string,
  photo: PropTypes.string,
  onLogout: PropTypes.func.isRequired,
  theme: PropTypes.string.isRequired,
};

export default ChatScreen;