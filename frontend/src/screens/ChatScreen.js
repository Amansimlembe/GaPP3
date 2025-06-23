// ChatScreen.js
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import axios from 'axios';
import { FaArrowLeft, FaEllipsisV, FaPaperclip, FaSmile, FaPaperPlane, FaTimes, FaSignOutAlt, FaPlus, FaImage, FaVideo, FaFile, FaMusic } from 'react-icons/fa';
import { motion, AnimatePresence } from 'framer-motion';
import Picker from 'emoji-picker-react';
import { VariableSizeList } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { openDB } from 'idb';
import { setMessages, addMessage, replaceMessage, updateMessageStatus, setSelectedChat, setChatList, resetState, clearAuth } from '../store';
import './ChatScreen.css';

const BASE_URL = 'https://gapp-6yc3.onrender.com';
const CACHE_DURATION = 3 * 60 * 1000; // Changed: Reduced to 3 minutes for fresher data
const MAX_OFFLINE_QUEUE_SIZE = 100;
const MAX_MESSAGES = 100;
const MAX_RETRIES = 3;
const DB_NAME = 'chatApp';

const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id?.toString() || '');
const isValidVirtualNumber = (number) => /^\+\d{7,15}$/.test(number?.trim() || '');
const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
  get(key) {
    const value = this.cache.get(key);
    if (value) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }
}

const ChatScreen = React.memo(({ token, userId, setAuth, socket, username, virtualNumber, photo, privateKey }) => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { selectedChat, chats, chatList, chatListTimestamp } = useSelector((state) => state.messages);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState([]);
  const [showMenu, setShowMenu] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [contactInput, setContactInput] = useState('');
  const [contactError, setContactError] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAttachmentPicker, setShowAttachmentPicker] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [unreadMessages, setUnreadMessages] = useState({});
  const [isForgeReady, setIsForgeReady] = useState(false);
  const [isLoadingChatList, setIsLoadingChatList] = useState(true);
  const [isLoadingAddContact, setIsLoadingAddContact] = useState(false);
  const [file, setFile] = useState(null);
  const [forge, setForge] = useState(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [totalMessages, setTotalMessages] = useState(0);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const listRef = useRef(null);
  const menuRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const typingDebounceRef = useRef(null);
  const sentStatusesRef = useRef(new LRUCache(1000));
  const offlineQueueRef = useRef([]);
  const abortControllerRef = useRef(new AbortController());
  const isFetchingChatListRef = useRef(false);
  const isFetchingMessagesRef = useRef(new Map());
  const fetchChatListDebounceRef = useRef(null);

  // Initialize IndexedDB
  const initDB = async () => {
    return openDB(DB_NAME, 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('offlineMessages', { keyPath: 'clientMessageId' });
        }
      },
    });
  };

  // Load node-forge
  useEffect(() => {
    let isMounted = true;
    const loadForge = async () => {
      try {
        const forgeModule = await import('node-forge');
        if (isMounted) {
          setForge(forgeModule.default || forgeModule);
          setIsForgeReady(true);
          console.log('node-forge loaded successfully');
        }
      } catch (err) {
        if (isMounted) {
          setErrors((prev) => [...prev, 'Encryption library failed to load']);
          console.error('Failed to load node-forge:', err);
          logClientError('node-forge load failed', err);
        }
      } finally {
        if (isMounted) setIsLoadingChatList(false);
      }
    };
    loadForge();
    return () => { isMounted = false; };
  }, []); // Changed: Removed logClientError dependency to avoid potential loop

  // Log client errors
  const logClientError = useCallback(async (message, error) => {
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

  // Get public key
  const getPublicKey = useCallback(async (recipientId) => {
    if (!isValidObjectId(recipientId)) throw new Error('Invalid recipient ID');
    const cacheKey = `publicKey:${recipientId}`;
    const cachedKey = sessionStorage.getItem(cacheKey);
    if (cachedKey) return cachedKey;
    try {
      const { data } = await axios.get(`${BASE_URL}/auth/public_key/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
        signal: abortControllerRef.current.signal,
      });
      if (!data.publicKey) throw new Error('No public key returned');
      sessionStorage.setItem(cacheKey, data.publicKey);
      return data.publicKey;
    } catch (err) {
      if (err.response?.status === 401) {
        setErrors((prev) => [...prev, 'Session expired, please log in again']);
        setTimeout(() => handleLogout(), 2000);
      }
      throw err;
    }
  }, [token, handleLogout]);

  // Encrypt message
  const encryptMessage = useCallback(async (content, recipientPublicKey, isMedia = false) => {
    if (!forge || !recipientPublicKey) throw new Error('Encryption dependencies missing');
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
      throw new Error('Failed to encrypt message');
    }
  }, [forge]);

  // Decrypt message
  const decryptMessage = useCallback(async (encryptedContent) => {
    if (!forge || !privateKey) throw new Error('Decryption dependencies missing');
    try {
      const [data, iv, encryptedKey] = encryptedContent.split('|').map(forge.util.decode64);
      const aesKey = forge.pki.privateKeyFromPem(privateKey).decrypt(encryptedKey, 'RSA-OAEP', { md: forge.md.sha256.create() });
      const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
      decipher.start({ iv: forge.util.createBuffer(iv) });
      decipher.update(forge.util.createBuffer(data));
      decipher.finish();
      return forge.util.decodeUtf8(decipher.output.getBytes());
    } catch (err) {
      return '[Message not decrypted]';
    }
  }, [forge, privateKey]);

  // Retry with backoff
  const retryWithBackoff = useCallback(async (fn, maxRetries, attempt = 1) => {
    try {
      await fn();
      return true;
    } catch (err) {
      if (err.response?.status === 401 || err.message === 'Unauthorized') {
        setErrors((prev) => [...prev, 'Session expired']);
        handleLogout();
        return false;
      }
      if (err.response?.status === 429) {
        setErrors((prev) => [...prev, err.response.data.message || 'Too many requests']);
        return false;
      }
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return retryWithBackoff(fn, maxRetries, attempt + 1);
      }
      setErrors((prev) => [...prev, `Failed: ${err.response?.data?.error || err.message || 'Unknown error'}`]);
      return false;
    }
  }, [handleLogout]);

  // Fetch chat list
  const fetchChatList = useCallback(async () => {
    if (!isForgeReady || !token || !userId || isFetchingChatListRef.current) return;
    if (chatListTimestamp > Date.now() - CACHE_DURATION && chatList.length) {
      setIsLoadingChatList(false);
      return;
    }
    clearTimeout(fetchChatListDebounceRef.current);
    fetchChatListDebounceRef.current = setTimeout(async () => {
      isFetchingChatListRef.current = true;
      setIsLoadingChatList(true);
      try {
        const success = await retryWithBackoff(async () => {
          const { data } = await axios.get(`${BASE_URL}/social/chat-list`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { userId },
            timeout: 5000,
            signal: abortControllerRef.current.signal,
          });
          dispatch(setChatList(data.map((chat) => ({
            ...chat,
            _id: chat.id?.toString(),
            id: chat.id?.toString(),
            unreadCount: unreadMessages[chat.id] || chat.unreadCount || 0,
          }))));
          setErrors((prev) => prev.filter((e) => !e.includes('chat list')));
        }, MAX_RETRIES);
      } catch (err) {
        console.error('Fetch chat list error:', err);
      } finally {
        isFetchingChatListRef.current = false;
        setIsLoadingChatList(false);
      }
    }, 500);
  }, [isForgeReady, token, userId, chatListTimestamp, chatList.length, dispatch, unreadMessages, retryWithBackoff]);

  // Logout handler
  const handleLogout = useCallback(async () => {
    try {
      socket?.emit('leave', userId);
      await axios.post(`${BASE_URL}/social/logout`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });
      socket?.disconnect();
      dispatch(clearAuth());
      dispatch(resetState());
      setAuth('', '', '', '', '', '');
      const db = await initDB();
      await db.clear('offlineMessages');
      navigate('/login');
    } catch (err) {
      dispatch(clearAuth());
      dispatch(resetState());
      setAuth('', '', '', '', '', '');
      const db = await initDB();
      await db.clear('offlineMessages');
      navigate('/login');
    }
  }, [socket, userId, token, dispatch, setAuth, navigate]);

  // Fetch messages
  const fetchMessages = useCallback(async (chatId) => {
    if (!isValidObjectId(chatId) || !token || !hasMore || isFetchingMessagesRef.current.get(chatId)) return;
    isFetchingMessagesRef.current.set(chatId, true);
    try {
      const success = await retryWithBackoff(async () => {
        const { data } = await axios.get(`${BASE_URL}/social/messages`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId: chatId, limit: 20, skip: page * 20 },
          timeout: 5000,
          signal: abortControllerRef.current.signal,
        });
        const existingMessages = chats[chatId] || [];
        const existingIds = new Set(existingMessages.map((msg) => msg._id || msg.clientMessageId));
        const newMessages = await Promise.all(
          data.map(async (msg) => {
            if (existingIds.has(msg._id)) return null;
            return {
              ...msg,
              _id: msg._id?.toString(),
              senderId: msg.senderId?.toString(),
              recipientId: msg.recipientId?.toString(),
              plaintextContent: msg.contentType === 'text' && msg.content ? await decryptMessage(msg.content) : msg.content,
              status: msg.status || 'sent',
              createdAt: new Date(msg.createdAt),
              updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined,
            };
          })
        ).filter(Boolean);
        dispatch(setMessages({
          recipientId: chatId,
          messages: [...newMessages, ...existingMessages]
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
            .slice(-MAX_MESSAGES),
        }));
        setTotalMessages(data.totalMessages || data.total);
        setHasMore(page * 20 + data.length < data.totalMessages || data.total);
        setPage((prev) => prev + 1);
        setUnreadMessages((prev) => ({ ...prev, [chatId]: 0 }));
        const failedMessages = (chats[chatId] || []).filter((m) => m.status === 'failed');
        failedMessages.forEach((msg) => retrySendMessage(msg));
      }, MAX_RETRIES);
    } finally {
      isFetchingMessagesRef.current.delete(chatId);
    }
  }, [token, userId, chats, page, hasMore, dispatch, decryptMessage, retryWithBackoff, retrySendMessage]);

  // Select chat
  const selectChat = useCallback((chatId) => {
    if (!isForgeReady) {
      setErrors((prev) => [...prev, 'Chat is still loading, please wait.']);
      return;
    }
    dispatch(setSelectedChat(chatId || null));
    setShowMenu(false);
    setErrors([]);
    setPage(0);
    setHasMore(true);
    setTotalMessages(0);
    if (chatId && socket && isValidObjectId(chatId)) {
      fetchMessages(chatId);
      const unreadMessageIds = (chats[chatId] || [])
        .filter((msg) => msg.status !== 'read' && msg.recipientId?.toString() === userId && !sentStatusesRef.current?.get(msg._id))
        .map((msg) => msg._id);
      if (unreadMessageIds.length) {
        socket.emit('batchMessageStatus', {
          messageIds: unreadMessageIds,
          status: 'read',
          recipientId: userId,
        });
        unreadMessageIds.forEach((id) => {
          const msg = chats[chatId]?.find((m) => m._id === id);
          if (msg) sentStatusesRef.current.set(id, 'read');
        });
      }
      setUnreadMessages((prev) => ({ ...prev, [chatId]: 0 }));
    }
    inputRef.current?.focus();
  }, [socket, isForgeReady, chats, userId, dispatch, fetchMessages]);

  // Send message
  const sendMessage = useCallback(async () => {
    if (!isForgeReady || !message.trim() || !selectedChat || !isValidObjectId(selectedChat)) return;
    const clientMessageId = generateClientMessageId();
    const plaintextContent = message.trim();
    const messageData = {
      senderId: userId,
      recipientId: selectedChat,
      content: '',
      contentType: 'text',
      plaintextContent,
      clientMessageId,
      senderVirtualNumber: virtualNumber,
      senderUsername: username,
      senderPhoto: photo,
      status: 'pending',
      createdAt: new Date(),
    };
    dispatch(addMessage({ recipientId: selectedChat, message: messageData }));
    setMessage('');
    const db = await initDB();
    try {
      if (!socket?.connected || !navigator.onLine) {
        if (offlineQueueRef.current.length >= MAX_OFFLINE_QUEUE_SIZE) {
          const oldest = offlineQueueRef.current.shift();
          await db.delete('offlineMessages', oldest.clientMessageId);
        }
        offlineQueueRef.current.push(messageData);
        await db.put('offlineMessages', messageData);
        setErrors((prev) => [...prev, 'Offline. Message queued.']);
        return;
      }
      const recipientPublicKey = await getPublicKey(selectedChat);
      messageData.content = await encryptMessage(plaintextContent, recipientPublicKey);
      const { data } = await axios.post(`${BASE_URL}/social/messages`, messageData, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
        signal: abortControllerRef.current.signal,
      });
      socket.emit('message', messageData, async (ack) => {
        if (ack?.error) {
          dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
          offlineQueueRef.current.push(messageData);
          await db.put('offlineMessages', messageData);
          return;
        }
        const populatedMessage = {
          ...ack.message,
          _id: ack.message._id?.toString(),
          senderId: ack.message.senderId?.toString(),
          recipientId: ack.message.recipientId?.toString(),
          plaintextContent,
          status: ack.message.status || 'sent',
        };
        dispatch(replaceMessage({
          recipientId: selectedChat,
          message: populatedMessage,
          replaceId: clientMessageId,
        }));
        dispatch(updateMessageStatus({
          recipientId: selectedChat,
          messageId: populatedMessage._id,
          status: populatedMessage.status,
        }));
        await db.delete('offlineMessages', clientMessageId);
      });
      listRef.current?.scrollToItem((chats[selectedChat]?.length || 0) + 1, 'end');
    } catch (err) {
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
      offlineQueueRef.current.push(messageData);
      await db.put('offlineMessages', messageData);
    }
  }, [isForgeReady, message, selectedChat, userId, virtualNumber, username, photo, socket, token, getPublicKey, encryptMessage, dispatch, chats]);

  // Retry send message
  const retrySendMessage = useCallback(async (message) => {
    if (!socket?.connected || !isValidObjectId(message.recipientId) || !navigator.onLine) return;
    const db = await initDB();
    try {
      dispatch(updateMessageStatus({
        recipientId: message.recipientId,
        messageId: message.clientMessageId,
        status: 'pending',
      }));
      if (message.contentType !== 'text' && message.file) {
        const formData = new FormData();
        formData.append('file', new Blob([message.file], { type: message.contentType }));
        Object.keys(message).forEach((key) => {
          if (key !== 'file') formData.append(key, message[key]);
        });
        const { data } = await axios.post(`${BASE_URL}/social/upload`, formData, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
          timeout: 30000,
          signal: abortControllerRef.current.signal,
        });
        dispatch(replaceMessage({
          recipientId: message.recipientId,
          message: {
            ...data.message,
            _id: data.message._id?.toString(),
            senderId: data.message.senderId?.toString(),
            recipientId: data.message.recipientId?.toString(),
          },
          replaceId: message.clientMessageId,
        }));
        dispatch(updateMessageStatus({
          recipientId: message.recipientId,
          messageId: data.message._id?.toString(),
          status: data.message.status || 'sent',
        }));
      } else {
        const recipientPublicKey = await getPublicKey(message.recipientId);
        message.content = await encryptMessage(message.plaintextContent, recipientPublicKey);
        const { data } = await axios.post(`${BASE_URL}/social/messages`, message, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
          signal: abortControllerRef.current.signal,
        });
        socket.emit('message', message, (ack) => {
          if (ack?.error) {
            dispatch(updateMessageStatus({
              recipientId: message.recipientId,
              messageId: message.clientMessageId,
              status: 'failed',
            }));
            return;
          }
          dispatch(replaceMessage({
            recipientId: message.recipientId,
            message: {
              ...ack.message,
              _id: ack.message._id?.toString(),
              senderId: ack.message.senderId?.toString(),
              recipientId: ack.message.recipientId?.toString(),
              plaintextContent: message.plaintextContent,
              status: ack.message.status || 'sent',
            },
            replaceId: message.clientMessageId,
          }));
          dispatch(updateMessageStatus({
            recipientId: message.recipientId,
            messageId: ack.message._id?.toString(),
            status: ack.message.status || 'sent',
          }));
        });
      }
      offlineQueueRef.current = offlineQueueRef.current.filter((m) => m.clientMessageId !== message.clientMessageId);
      await db.delete('offlineMessages', message.clientMessageId);
    } catch (err) {
      dispatch(updateMessageStatus({
        recipientId: message.recipientId,
        messageId: message.clientMessageId,
        status: 'failed',
      }));
    }
  }, [socket, dispatch, token, getPublicKey, encryptMessage]);

  // Handle attachment
  const handleAttachment = useCallback(async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile || !selectedChat || !isValidObjectId(selectedChat)) return;
    if (selectedFile.size > 50 * 1024 * 1024) {
      setErrors((prev) => [...prev, 'File size exceeds 50MB']);
      return;
    }
    setFile(selectedFile);
    setShowAttachmentPicker(false);
    const clientMessageId = generateClientMessageId();
    const tempMessage = {
      senderId: userId,
      recipientId: selectedChat,
      content: '',
      contentType: selectedFile.type.startsWith('image/') ? 'image' :
                   selectedFile.type.startsWith('video/') ? 'video' :
                   selectedFile.type.startsWith('audio/') ? 'audio' : 'document',
      originalFilename: selectedFile.name,
      clientMessageId,
      status: 'pending',
      createdAt: new Date(),
    };
    dispatch(addMessage({ recipientId: selectedChat, message: tempMessage }));
    const db = await initDB();
    try {
      if (!socket?.connected || !navigator.onLine) {
        if (offlineQueueRef.current.length >= MAX_OFFLINE_QUEUE_SIZE) {
          const oldest = offlineQueueRef.current.shift();
          await db.delete('offlineMessages', oldest.clientMessageId);
        }
        offlineQueueRef.current.push({ ...tempMessage, file: await selectedFile.arrayBuffer() });
        await db.put('offlineMessages', { ...tempMessage, file: await selectedFile.arrayBuffer() });
        setErrors((prev) => [...prev, 'Offline. File queued.']);
        return;
      }
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('userId', userId);
      formData.append('recipientId', selectedChat);
      formData.append('clientMessageId', clientMessageId);
      formData.append('senderVirtualNumber', virtualNumber);
      formData.append('senderUsername', username);
      formData.append('senderPhoto', photo);
      const { data } = await axios.post(`${BASE_URL}/social/upload`, formData, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
        timeout: 30000,
        signal: abortControllerRef.current.signal,
      });
      dispatch(replaceMessage({
        recipientId: selectedChat,
        message: {
          ...data.message,
          _id: data.message._id?.toString(),
          senderId: data.message.senderId?.toString(),
          recipientId: data.message.recipientId?.toString(),
        },
        replaceId: clientMessageId,
      }));
      dispatch(updateMessageStatus({
        recipientId: selectedChat,
        messageId: data.message._id?.toString(),
        status: data.message.status || 'sent',
      }));
      setFile(null);
      listRef.current?.scrollToItem((chats[selectedChat]?.length || 0) + 1, 'end');
    } catch (err) {
      setErrors((prev) => [...prev, `Failed to upload file: ${err.response?.data?.error || 'Unknown error'}`]);
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
      offlineQueueRef.current.push({ ...tempMessage, file: await selectedFile.arrayBuffer() });
      await db.put('offlineMessages', { ...tempMessage, file: await selectedFile.arrayBuffer() });
    }
  }, [selectedChat, userId, virtualNumber, username, photo, token, dispatch, socket, chats]);

  // Add contact
  const handleAddContact = useCallback(async () => {
    if (!contactInput.trim() || !isValidVirtualNumber(contactInput)) {
      setContactError('Invalid virtual number (e.g., +1234567890)');
      return;
    }
    setIsLoadingAddContact(true);
    try {
      const success = await retryWithBackoff(async () => {
        const { data } = await axios.post(
          `${BASE_URL}/social/add_contact`,
          { userId, virtualNumber: contactInput.trim() },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 5000, signal: abortControllerRef.current.signal }
        );
        const newChat = {
          id: data.id?.toString(),
          _id: data.id?.toString(),
          username: data.username || 'Unknown',
          virtualNumber: data.virtualNumber || '',
          photo: data.photo || 'https://placehold.co/40x40',
          status: data.status || 'offline',
          lastSeen: data.lastSeen || null,
          latestMessage: null,
          unreadCount: 0,
        };
        dispatch(setChatList([...chatList.filter((msg) => msg.id !== newChat.id), newChat]));
        setContactInput('');
        setContactError('');
        setShowAddContact(false);
        setErrors([]);
      }, MAX_RETRIES);
    } finally {
      setIsLoadingAddContact(false);
    }
  }, [contactInput, token, userId, chatList, dispatch, retryWithBackoff]);

  // Handle incoming message
  const handleMessage = useCallback(async (msg) => {
    try {
      const senderId = typeof msg.senderId === 'object' ? msg.senderId._id?.toString() : msg.senderId?.toString();
      const recipientId = typeof msg.recipientId === 'object' ? msg.recipientId._id?.toString() : msg.recipientId?.toString();
      if (!isValidObjectId(senderId) || !isValidObjectId(recipientId)) return;
      const targetId = senderId === userId ? recipientId : senderId;
      const plaintextContent = msg.contentType === 'text' && msg.content ? await decryptMessage(msg.content) : msg.content;
      const messageData = {
        ...msg,
        _id: msg._id?.toString(),
        senderId,
        recipientId,
        plaintextContent,
        status: msg.status || 'delivered',
        createdAt: new Date(msg.createdAt),
        updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined,
      };
      dispatch(addMessage({ recipientId: targetId, message: messageData }));
      if (selectedChat === targetId && document.hasFocus()) {
        if (!sentStatusesRef.current.get(msg._id)) {
          socket.emit('messageStatus', {
            messageId: msg._id,
            status: 'read',
          });
          sentStatusesRef.current.set(msg._id, 'read');
          dispatch(updateMessageStatus({
            recipientId: targetId,
            messageId: msg._id,
            status: 'read',
          }));
        }
        setUnreadMessages((prev) => ({ ...prev, [targetId]: 0 }));
        listRef.current?.scrollToItem((chats[targetId]?.length || 0) + 1, 'end');
      } else {
        setUnreadMessages((prev) => ({ ...prev, [targetId]: (prev[targetId] || 0) + 1 }));
      }
    } catch (err) {
      console.error('Handle message error:', err);
    }
  }, [dispatch, decryptMessage, selectedChat, userId, socket, chats]);

  // Socket event listeners
  useEffect(() => {
    if (!socket || !isForgeReady || !userId) return;

    const handleConnect = () => {
      socket.emit('join', userId);
      if (!isFetchingChatListRef.current) fetchChatList();
      if (selectedChat && isValidObjectId(selectedChat)) {
        fetchMessages(selectedChat);
      }
      offlineQueueRef.current.forEach((message) => retrySendMessage(message));
    };

    const handleConnectError = (err) => {
      console.error('Socket connect error:', err.message);
      if (err.message.includes('Invalid token')) {
        setErrors((prev) => [...prev, 'Session expired']);
        handleLogout();
      }
    };

    const handleNewContact = ({ contactData }) => {
      if (!contactData?.id || !isValidObjectId(contactData.id)) return;
      const newChat = {
        id: contactData.id?.toString(),
        _id: contactData.id?.toString(),
        username: contactData.username || 'Unknown',
        virtualNumber: contactData.virtualNumber || '',
        photo: contactData.photo || 'https://placehold.co/40x40',
        status: contactData.status || 'offline',
        lastSeen: contactData.lastSeen || null,
        latestMessage: null,
        unreadCount: contactData.unreadCount || 0,
      };
      dispatch(setChatList([...chatList.filter((msg) => msg.id !== newChat.id), newChat]));
    };

    const handleChatListUpdated = ({ userId: emitterId, users }) => {
      if (emitterId !== userId) return;
      dispatch(setChatList(users.map((message) => ({
        ...message,
        id: message.id?.toString(),
        _id: message.id?.toString(),
        unreadCount: unreadMessages[message.id] || message.unreadCount || 0,
      }))));
    };

    const handleTyping = ({ userId: typingUserId }) => {
      if (typingUserId === selectedChat) {
        setIsTyping((prev) => ({ ...prev, [typingUserId]: true }));
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
          setIsTyping((prev) => ({ ...prev, [typingUserId]: false }));
        }, 3000);
      }
    };

    const handleStopTyping = ({ userId: typingUserId }) => {
      if (typingUserId === selectedChat) {
        setIsTyping((prev) => ({ ...prev, [typingUserId]: false }));
      }
    };

    const handleMessageStatus = ({ messageIds, status }) => {
      messageIds.forEach((messageId) => {
        Object.keys(chats).forEach((chatId) => {
          const message = chats[chatId]?.find((msg) => msg._id === messageId && msg.senderId?.toString() === userId);
          if (message) {
            dispatch(updateMessageStatus({
              recipientId: chatId,
              messageId: message._id,
              status,
            }));
            sentStatusesRef.current.set(message._id, status);
          }
        });
      });
    };

    socket.on('connect', handleConnect);
    socket.on('connect_error', handleConnectError);
    socket.on('contactData', handleNewContact);
    socket.on('chatListUpdated', handleChatListUpdated);
    socket.on('message', handleMessage);
    socket.on('typing', handleTyping);
    socket.on('stopTyping', handleStopTyping);
    socket.on('messageStatus', handleMessageStatus);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('connect_error', handleConnectError);
      socket.off('contactData', handleNewContact);
      socket.off('chatListUpdated', handleChatListUpdated);
      socket.off('message', handleMessage);
      socket.off('typing', handleTyping);
      socket.off('stopTyping', handleStopTyping);
      socket.off('messageStatus', handleMessageStatus);
      socket.emit('leave', userId);
      clearTimeout(fetchChatListDebounceRef.current);
    };
  }, [socket, isForgeReady, selectedChat, userId, chats, chatList, unreadMessages, dispatch, fetchChatList, fetchMessages, retrySendMessage, handleMessage, handleLogout]);

  // Validate auth and fetch initial data
  useEffect(() => {
    if (!token || !userId) {
      setErrors((prev) => [...prev, 'Please log in']);
      setIsLoadingChatList(false);
      navigate('/login');
      return;
    }
    if (isForgeReady && !isFetchingChatListRef.current) {
      fetchChatList();
    }
    return () => {
      abortControllerRef.current.abort();
      abortControllerRef.current = new AbortController();
      clearTimeout(fetchChatListDebounceRef.current);
    };
  }, [token, userId, isForgeReady, fetchChatList, navigate]);

  // Handle click outside
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
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle typing
  const handleTyping = useCallback(() => {
    if (!socket || !selectedChat) return;
    clearTimeout(typingDebounceRef.current);
    typingDebounceRef.current = setTimeout(() => {
      socket.emit('typing', { userId, recipientId: selectedChat });
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        socket.emit('stopTyping', { userId, recipientId: selectedChat });
      }, 3000);
    }, 500);
  }, [socket, selectedChat, userId]);

  // Get item size for VariableSizeList
  const getItemSize = useCallback(
    (index) => {
      const msg = chats[selectedChat]?.[index];
      if (!msg) return 60;
      const isMedia = ['image', 'video', 'audio', 'document'].includes(msg.contentType);
      return 60 + (isMedia ? 150 : 0) + (msg.caption ? 20 : 0);
    },
    [chats, selectedChat]
  );

  // Render message row
  const Row = useCallback(
    ({ index, style }) => {
      const msg = chats[selectedChat]?.[index];
      if (!msg) return null;
      const prevMsg = index > 0 ? chats[selectedChat][index - 1] : null;
      const showDate = !prevMsg || new Date(msg.createdAt).toDateString() !== new Date(prevMsg.createdAt).toDateString();
      const isMine = msg.senderId?.toString() === userId;

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
                    {msg.status === 'pending' && <span className="status-pending">o</span>}
                    {msg.status === 'sent' && <span className="status-sent">✓</span>}
                    {msg.status === 'delivered' && <span className="status-delivered">✓✓</span>}
                    {msg.status === 'read' && <span className="status-read">✓✓</span>}
                    {msg.status === 'failed' && <span className="status-failed">!</span>}
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

  // Render
  if (!isForgeReady) {
    return <div className="loading-screen">Loading chat...</div>;
  }

  return (
    <div className="chat-screen">
      {errors.length > 0 && (
        <div className="error-banner">
          {errors.map((error, index) => (
            <div key={index} className="error-item">
              <p>{error}</p>
              <div className="error-actions">
                {error.includes('retry') && (
                  <button
                    className="retry-button bg-primary text-white px-4 py-2 rounded"
                    onClick={() => fetchChatList()}
                  >
                    Retry
                  </button>
                )}
                <FaTimes
                  className="dismiss-icon"
                  onClick={() => setErrors((prev) => prev.filter((_, i) => i !== index))}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="chat-header">
        <h1 className="title">Gian Chat</h1>
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
                <div className="menu-item" onClick={() => { setShowAddContact(true); setShowMenu(true); }}>
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
          {isLoadingChatList ? (
            <span className="loading-screen">Loading contacts...</span>
          ) : chatList.length === 0 ? (
            <div className="no-contacts-message">
              <p>No contacts to display. Add a contact to start chatting!</p>
              <button
                className="add-contact-button bg-primary text-white px-4 py-2 rounded mt-2"
                onClick={() => { setShowAddContact(true); setShowMenu(true); }}
              >
                Add Contact
              </button>
            </div>
          ) : (
            chatList.map((chat) => (
              <div
                key={chat.id}
                className={`chat-list-item ${selectedChat === chat.id ? 'selected' : ''}`}
                onClick={() => selectChat(chat.id)}
              >
                <img
                  src={chat.photo || 'https://placehold.co/40x40'}
                  alt="Avatar"
                  className="chat-list-avatar"
                />
                <div className="chat-list-info">
                  <div className="chat-list-header">
                    <span className="chat-list-username">{chat.username}</span>
                    {chat.latestMessage && (
                      <span className="chat-list-time">
                        {new Date(chat.latestMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  {chat.latestMessage && (
                    <p className="chat-list-preview">{chat.latestMessage.plaintextContent || `[${chat.latestMessage.contentType}]`}</p>
                  )}
                  {!!unreadMessages[chat.id] && (
                    <span className="chat-list-unread">{unreadMessages[chat.id]}</span>
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
                  src={chatList.find((c) => c.id === selectedChat)?.photo || 'https://placehold.co/40x40'}
                  alt="Avatar"
                  className="conversation-info-img"
                />
                <div className="conversation-info">
                  <h2 className="title">{chatList.find((c) => c.id === selectedChat)?.username || ''}</h2>
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
                        onItemsRendered={({ visibleStartIndex }) => {
                          if (visibleStartIndex < 5 && hasMore) {
                            fetchMessages(selectedChat);
                          }
                        }}
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