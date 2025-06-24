
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
import { setMessages, addMessage, replaceMessage, updateMessageStatus, setSelectedChat, resetState, setChatList } from '../store';
import './ChatScreen.css';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);
const isValidVirtualNumber = (number) => /^\+\d{7,15}$/.test(number.trim());
const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

const ChatScreen = React.memo(({ token, userId, socket, username, virtualNumber, photo }) => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { selectedChat, chats, chatList, chatListTimestamp } = useSelector((state) => state.messages);
  const [localChatList, setChatList] = useState([]);
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
  const maxRetries = 3;
  const maxStatuses = 1000;
  const maxLogsPerMinute = 5;

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

  const errorLogMap = useRef(new Map());
  const logClientError = useCallback(async (message, error) => {
    const now = Date.now();
    const errorEntry = errorLogMap.current.get(message) || { count: 0, timestamps: [] };
    errorEntry.timestamps = errorEntry.timestamps.filter((ts) => now - ts < 60 * 1000);
    if (errorEntry.count >= 2 || errorEntry.timestamps.length >= maxLogsPerMinute) return;
    errorEntry.count += 1;
    errorEntry.timestamps.push(now);
    errorLogMap.current.set(message, errorEntry);
    try {
      await axios.post(`${BASE_URL}/social/log-error`, {
        error: message,
        stack: error?.stack || '',
        userId,
        route: window.location.pathname,
        timestamp: new Date().toISOString(),
      }, { timeout: 5000 });
    } catch (err) {
      console.error('Failed to log client error:', err.message);
    }
  }, [userId]);

  useEffect(() => {
    if (forge?.random && forge?.pki && forge.cipher) {
      setIsForgeReady(true);
    } else {
      console.error('Encryption library failed to load');
      logClientError('node-forge initialization failed', new Error('Forge not loaded'));
    }
    return () => {
      isMountedRef.current = false;
    };
  }, [logClientError]);

  const handleLogout = useCallback(async () => {
    try {
      if (socket) {
        socket.emit('leave', userId);
        socket.disconnect();
      }
      await axios.post(`${BASE_URL}/social/logout`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });
      sessionStorage.clear();
      localStorage.clear();
      dispatch(resetState());
      setChatList([]);
      setUnreadMessages({});
      sentStatusesRef.current.clear();
      dispatch(setSelectedChat(null));
      navigate('/');
    } catch (err) {
      console.error('Logout failed:', err.message);
      logClientError('Logout failed', err);
      if (err.response?.status === 401) {
        setTimeout(() => {
          sessionStorage.clear();
          localStorage.clear();
          dispatch(resetState());
          setChatList([]);
          setUnreadMessages({});
          sentStatusesRef.current.clear();
          dispatch(setSelectedChat(null));
          navigate('/');
        }, 1000);
      }
    }
  }, [socket, userId, token, navigate, dispatch, logClientError]);

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
        setTimeout(() => handleLogout(), 1000);
      }
      throw new Error('Failed to fetch public key');
    }
  }, [token, handleLogout, logClientError]);

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
    debounce(async (force = false) => {
      if (!isForgeReady || !isMountedRef.current) return;
      if (!force && chatListTimestamp && Date.now() - chatListTimestamp < 5 * 60 * 1000) {
        setChatList(chatList);
        setFetchStatus('success');
        setFetchError(null);
        return;
      }
      setFetchStatus('loading');
      let retryCount = retryCountRef.current.chatList;
      if (retryCount > maxRetries) {
        setFetchStatus('error');
        setFetchError('Max retries exceeded for chat list fetch');
        logClientError('Max retries exceeded for chat list fetch', new Error('Max retries exceeded'));
        return;
      }
      try {
        const { data } = await axios.get(`${BASE_URL}/social/chat-list`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId },
          timeout: 10000,
        });
        if (isMountedRef.current) {
          const updatedChatList = data.map((chat) => ({
            ...chat,
            _id: chat.id,
            unreadCount: unreadMessages[chat.id] || chat.unreadCount || 0,
          }));
          setChatList(updatedChatList);
          dispatch(setChatList(updatedChatList));
          setFetchStatus('success');
          setFetchError(null);
        }
        retryCountRef.current.chatList = 0;
        clearTimeout(retryTimeoutRef.current.chatList);
      } catch (err) {
        if (retryCount < maxRetries) {
          console.warn(`Chat list fetch attempt ${retryCount + 1} failed: ${err.message}`);
        } else {
          console.error('Chat list fetch failed:', err.message);
        }
        if (!isMountedRef.current) return;
        if (err.response?.status === 401) {
          logClientError('Chat list fetch failed: Unauthorized', err);
          setTimeout(() => handleLogout(), 1000);
          return;
        }
        let delay = 2000 * Math.pow(2, retryCount);
        if (err.response?.status === 429) {
          delay = 60000;
          setFetchError('Too many requests, please wait a minute');
        } else {
          setFetchError('Failed to load contacts, please try again');
        }
        if ((err.code === 'ECONNABORTED' || err.response?.status === 429 || err.response?.status === 503) && retryCount < maxRetries) {
          retryCount += 1;
          retryCountRef.current.chatList = retryCount;
          clearTimeout(retryTimeoutRef.current.chatList);
          retryTimeoutRef.current.chatList = setTimeout(() => fetchChatList(force), delay);
        } else {
          retryCountRef.current.chatList = 0;
          clearTimeout(retryTimeoutRef.current.chatList);
          setFetchStatus('error');
          logClientError('Chat list fetch failed', err);
        }
      }
    }, 1000),
    [isForgeReady, token, userId, handleLogout, unreadMessages, logClientError, dispatch, chatList, chatListTimestamp]
  );

  const fetchMessages = useCallback(async (chatId) => {
    if (!isForgeReady || !isValidObjectId(chatId) || !isMountedRef.current) return;
    try {
      const { data } = await axios.get(`${BASE_URL}/social/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, recipientId: chatId },
        timeout: 10000,
      });
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
        setTimeout(() => handleLogout(), 1000);
      }
    }
  }, [isForgeReady, token, userId, socket, dispatch, logClientError]);

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

  const handleAddContact = useCallback(async () => {
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
        lastSeen: response.data.lastSeen || null,
        latestMessage: null,
        unreadCount: 0,
      };
      setChatList((prev) => {
        if (prev.find((chat) => chat.id === newChat.id)) return prev;
        const updatedChatList = [...prev, newChat];
        dispatch(setChatList(updatedChatList));
        return updatedChatList;
      });
      setContactInput('');
      setContactError('');
      setShowAddContact(false);
      retryCountRef.current.addContact = 0;
      clearTimeout(retryTimeoutRef.current.addContact);
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
          setTimeout(() => handleLogout(), 1000);
        }
      }
    } finally {
      if (isMountedRef.current) setIsLoadingAddContact(false);
    }
  }, [contactInput, token, userId, handleLogout, logClientError, dispatch]);

  useEffect(() => {
    if (sentStatusesRef.current.size > maxStatuses) {
      const iterator = sentStatusesRef.current.values();
      for (let i = 0; i < sentStatusesRef.current.size - maxStatuses; i++) {
        sentStatusesRef.current.delete(iterator.next().value);
      }
    }
    return () => {
      sentStatusesRef.current.clear();
    };
  }, [chats]);

  useEffect(() => {
    if (!socket || !isForgeReady || !userId) return;

    let statusUpdateQueue = [];
    let statusUpdateTimeout = null;

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

    const handleNewContact = ({ userId: emitterId, contactData }) => {
      if (!contactData?.id || !isValidObjectId(contactData.id)) {
        console.error('Invalid contactData received:', contactData);
        return;
      }
      if (!isMountedRef.current) return;
      setChatList((prev) => {
        if (prev.find((chat) => chat.id === contactData.id)) return prev;
        const newChat = {
          id: contactData.id,
          _id: contactData.id,
          username: contactData.username || 'Unknown',
          virtualNumber: contactData.virtualNumber || '',
          photo: contactData.photo || 'https://placehold.co/40x40',
          status: contactData.status || 'offline',
          lastSeen: contactData.lastSeen || null,
          latestMessage: null,
          unreadCount: 0,
        };
        const updatedChatList = [...prev, newChat];
        dispatch(setChatList(updatedChatList));
        return updatedChatList;
      });
    };

    const handleChatListUpdated = ({ userId: emitterId, users }) => {
      if (emitterId !== userId || !isMountedRef.current) return;
      const updatedChatList = users.map((chat) => ({
        ...chat,
        _id: chat.id,
        unreadCount: unreadMessages[chat.id] || chat.unreadCount || 0,
      }));
      setChatList(updatedChatList);
      dispatch(setChatList(updatedChatList));
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
      setChatList([]);
      setUnreadMessages({});
      setIsTyping({});
    };
  }, [socket, isForgeReady, selectedChat, userId, chats, dispatch, unreadMessages]);

  useEffect(() => {
    if (!token || !userId) {
      console.error('Please log in to access chat');
      navigate('/');
      return;
    }
    if (isForgeReady) {
      if (chatList.length && chatListTimestamp && Date.now() - chatListTimestamp < 5 * 60 * 1000) {
        setChatList(chatList);
        setFetchStatus('success');
      } else {
        fetchChatList();
      }
      socket?.emit('join', userId);
    }
    const handleOffline = () => {
      setFetchError('You are offline. Displaying cached contacts.');
      setFetchStatus('cached');
      setChatList(chatList);
    };
    window.addEventListener('offline', handleOffline);
    return () => {
      clearTimeout(retryTimeoutRef.current.chatList);
      clearTimeout(retryTimeoutRef.current.addContact);
      sentStatusesRef.current = new Set();
      errorLogMap.current = new Map();
      window.removeEventListener('offline', handleOffline);
    };
  }, [token, userId, isForgeReady, socket, navigate, fetchChatList, chatList, chatListTimestamp]);

  useEffect(() => {
    if (selectedChat && !chats[selectedChat]) {
      fetchMessages(selectedChat);
    }
  }, [selectedChat, fetchMessages, chats]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowMenu(false);
        setShowAddContact(null);
        setShowAttachmentPicker(false);
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      setShowMenu(false);
      setShowAddContact(null);
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
    setShowMenu('');
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
            <div className="date-header">
              <span className="timestamp">{new Date(msg.createdAt).toLocaleDateString()}</span>
            </div>
          )}
          <div className="message-container" style={style}>
            <div className={`message ${isMine ? 'mine' : 'other'}`}>
              {msg.contentType === 'text' ? (
                <p className="message-content">{msg.plaintextContent || '[Message not decrypted]'}</p>
              ) : (
                <>
                  {msg.contentType === 'image' && <img src={msg.content} alt="media" className="message-media" />}
                  {msg.contentType === 'video' && <video src={msg.content} controls className="message-media" />}
                  {msg.contentType === 'audio' && <audio src={msg.content} controls className="message-audio" />}
                  {msg.contentType === 'document' && (
                    <a href={msg.content} className="message-document" target="_blank" rel="noopener noreferrer">
                      {msg.originalFilename || 'Document'}
                    </a>
                  )}
                  {msg.caption && <p className="message-caption">{msg.caption}</p>}
                </>
              )}
              <div className="message-meta">
                <span className="timestamp">{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                {isMine && (
                  <span className="message-status">
                    {msg.status === 'pending' ? 'o' : msg.status === 'sent' ? '✓' : msg.status === 'delivered' ? '✓✓' : '👀'}
                  </span>
                )}
              </div>
            </div>
          </div>
        </>
      );
    },
    [chats, selectedChat, userId]
  );

  if (!isForgeReady) {
    return (
      <div className="chat-screen">
        <div className="loading-screen">Encryption library failed to load</div>
      </div>
    );
  }

  return (
    <div className="chat-screen">
      <div className="chat-header">
        <h1 className="title">Grok Chat</h1>
        <div className="chat-menu">
          <FaEllipsisV className="menu-icon" onClick={() => setShowMenu(!showMenu)} />
          <AnimatePresence>
            {showMenu && (
              <motion.div
                ref={menuRef}
                className="menu-dropdown"
                initial={{ opacity: 0, y: 0 }}
                animate={{ opacity: 1, y: 10 }}
                exit={{ opacity: 0, y: 0 }}
                transition={{ duration: 0.2 }}
              >
                <div className="menu-item" onClick={() => { setShowAddContact(true); setShowMenu(false); }}>
                  <FaPlus className="menu-item-icon" />
                  Add Contact
                </div>
                <div className="menu-item logout" onClick={handleLogout}>
                  <FaSignOutAlt className="menu-item-icon" />
                  Logout
                </div>
                {showAddContact && (
                  <div className="menu-add-contact">
                    <div className="contact-input-group">
                      <input
                        type="text"
                        className={`contact-input input ${contactError ? 'error' : ''}`}
                        value={contactInput}
                        onChange={(e) => setContactInput(e.target.value)}
                        placeholder="Enter virtual number (e.g., +1234567890)"
                        disabled={isLoadingAddContact}
                      />
                      {contactInput && (
                        <FaTimes
                          className="clear-input-icon"
                          onClick={() => setContactInput('')}
                        />
                      )}
                    </div>
                    {contactError && <p className="error-text">{contactError}</p>}
                    <button
                      className="contact-button"
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
      <div className="chat-content">
        <div className={`chat-list ${selectedChat ? 'hidden md:block' : 'block'}`}>
          <button
            className="refresh-button bg-primary text-white px-4 py-2 rounded mb-2"
            onClick={() => fetchChatList(true)}
          >
            Refresh Contacts
          </button>
          {fetchStatus === 'loading' && (
            <div className="loading-message">
              <p>Loading contacts...</p>
            </div>
          )}
          {(fetchStatus === 'error' || fetchStatus === 'cached') && (
            <div className="error-message">
              <p>{fetchError}</p>
              {fetchStatus === 'error' && (
                <button
                  className="retry-button bg-primary text-white px-4 py-2 rounded mt-2"
                  onClick={() => {
                    retryCountRef.current.chatList = 0;
                    fetchChatList(true);
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {fetchStatus === 'success' && localChatList.length === 0 && (
            <div className="no-contacts-message">
              <p>No contacts to display. Add a contact to start chatting!</p>
              <button
                className="add-contact-button bg-primary text-white px-4 py-2 rounded mt-2"
                onClick={() => { setShowAddContact(true); setShowMenu(true); }}
              >
                Add Contact
              </button>
            </div>
          )}
          {(fetchStatus === 'success' || fetchStatus === 'cached') && localChatList.length > 0 && (
            localChatList.map((chat) => (
              <div
                key={chat.id}
                className={`chat-list-item ${selectedChat === chat.id ? 'selected' : ''}`}
                onClick={() => selectChat(chat.id)}
              >
                <img
                  src={chat.photo || 'https://placehold.co/40x40'}
                  alt="chat-avatar"
                  className="chat-list-img"
                />
                <div className="chat-list-info">
                  <div className="chat-list-header">
                    <span className="chat-list-username">{chat.username}</span>
                    {chat.latestMessage && (
                      <span className="chat-list-time">
                        {new Date(chat.latestMessage?.createdAt || chat.lastSeen || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  {chat.latestMessage && (
                    <p className="chat-list-preview">{chat.latestMessage.plaintextContent || `[${chat.latestMessage.contentType}]`}</p>
                  )}
                  {!!chat.unreadCount && (
                    <span className="chat-list-unread">{chat.unreadCount}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
        <div className={`chat-conversation ${selectedChat ? 'block' : 'hidden md:block'}`}>
          {selectedChat ? (
            <>
              <div className="conversation-header">
                <FaArrowLeft className="back-icon md:hidden" onClick={() => selectChat(null)} />
                <img
                  src={localChatList.find((c) => c.id === selectedChat)?.photo || 'https://placehold.co/40x40'}
                  alt="chat-avatar-img"
                  className="conversation-avatar-img"
                />
                <div className="conversation-info">
                  <h2 className="title">{localChatList.find((c) => c.id === selectedChat)?.username || ''}</h2>
                  {isTyping[selectedChat] && <span className="typing-indicator">Typing...</span>}
                </div>
              </div>
              <div className="conversation-messages">
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
                  <p className="no-messages">No messages yet</p>
                )}
              </div>
              <div className="input-bar">
                <FaSmile
                  className="emoji-icon"
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                />
                {showEmojiPicker && (
                  <Picker
                    onEmojiClick={(emojiObject) => {
                      setMessage((prev) => prev + emojiObject.emoji);
                      setShowEmojiPicker(false);
                    }}
                  />
                )}
                <FaPaperclip
                  className="attachment-icon"
                  onClick={() => setShowAttachmentPicker(!showAttachmentPicker)}
                />
                {showAttachmentPicker && (
                  <div className="attachment-picker">
                    <label htmlFor="attach-image" className="picker-item">
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
                    <label htmlFor="attach-video" className="picker-item">
                      <FaVideo />
                      <input
                        id="attach-video"
                        type="file"
                        accept="video/*"
                        onChange={handleAttachment}
                        style={{ display: 'none' }}
                      />
                    </label>
                    <label htmlFor="attach-audio" className="picker-item">
                      <FaMusic />
                      <input
                        id="attach-audio"
                        type="file"
                        accept="audio/*"
                        onChange={handleAttachment}
                        style={{ display: 'none' }}
                      />
                    </label>
                    <label htmlFor="attach-document" className="picker-item">
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
                  className="message-input input"
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
                <FaPaperPlane className="send-icon" onClick={sendMessage} />
              </div>
            </>
          ) : (
            <p className="no-messages">Select a chat to start messaging</p>
          )}
        </div>
      </div>
    </div>
  );
});

export default ChatScreen;