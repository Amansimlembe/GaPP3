import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import axios from 'axios';
import { FaArrowLeft, FaEllipsisV, FaPaperclip, FaSmile, FaPaperPlane, FaTimes, FaSignOutAlt, FaPlus, FaImage, FaVideo, FaFile, FaMusic } from 'react-icons/fa';
import { motion, AnimatePresence } from 'framer-motion';
import Picker from 'emoji-picker-react';
import { VariableSizeList } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { setMessages, addMessage, replaceMessage, updateMessageStatus, setSelectedChat, resetState } from '../store';
import './ChatScreen.css';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);
const isValidVirtualNumber = (number) => /^\+\d{7,15}$/.test(number.trim());
const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

// Controlled retry utility
const safeRetry = (fn, maxRetries, baseDelay, onError) => {
  let retries = 0;
  const attempt = async () => {
    try {
      await fn();
      retries = 0; // Reset retries on success
    } catch (err) {
      if (retries >= maxRetries || err.response?.status === 401) {
        onError(err);
        return;
      }
      retries += 1;
      const delay = baseDelay * Math.pow(2, retries);
      console.log(`Retrying (${retries}/${maxRetries}) after ${delay}ms...`);
      setTimeout(attempt, delay);
    }
  };
  attempt();
};

const ChatScreen = React.memo(({ token, userId, setAuth, socket, username, virtualNumber, photo }) => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { selectedChat, chats } = useSelector((state) => state.messages);
  const [chatList, setChatList] = useState([]);
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
  const forgeRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const listRef = useRef(null);
  const menuRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const typingDebounceRef = useRef(null);
  const sentStatusesRef = useRef(new Set());
  const maxStatuses = 1000;

  // Throttle function for socket emissions
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

  // Throttled error logging
  const errorLogTimestamps = useRef([]);
  const maxLogsPerMinute = 5; // Reduced to minimize calls
  const logClientError = useCallback(async (message, error) => {
    const now = Date.now();
    errorLogTimestamps.current = errorLogTimestamps.current.filter((ts) => now - ts < 60 * 1000);
    if (errorLogTimestamps.current.length >= maxLogsPerMinute) {
      console.warn('Error logging throttled');
      return;
    }
    errorLogTimestamps.current.push(now);
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

  // Lazy-load node-forge
  useEffect(() => {
    import('node-forge').then((forge) => {
      forgeRef.current = forge;
      if (forge.random && forge.cipher && forge.pki) {
        setIsForgeReady(true);
      } else {
        console.log('Encryption library failed to load');
        console.error('node-forge initialization failed:', forge);
        logClientError('node-forge initialization failed', new Error('Forge not loaded'));
      }
    }).catch((err) => {
      console.log('Failed to load encryption library');
      console.error('node-forge load error:', err);
      logClientError('node-forge load failed', err);
    });
  }, [logClientError]);

  const handleLogout = useCallback(async () => {
    try {
      // Validate token before attempting logout
      if (!token || !userId) {
        console.log('No valid token or userId, proceeding with client-side logout');
        if (socket) {
          socket.emit('leave', userId);
          socket.disconnect();
        }
        sessionStorage.clear();
        localStorage.clear();
        dispatch(resetState());
        setAuth(null, null, null, null, null, null);
        setChatList([]);
        setUnreadMessages({});
        sentStatusesRef.current.clear();
        dispatch(setSelectedChat(null));
        navigate('/');
        return;
      }

      // Attempt logout request
      await axios.post(`${BASE_URL}/auth/logout`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });

      if (socket) {
        socket.emit('leave', userId);
        socket.disconnect();
      }
      sessionStorage.clear();
      localStorage.clear();
      dispatch(resetState());
      setAuth(null, null, null, null, null, null);
      setChatList([]);
      setUnreadMessages({});
      sentStatusesRef.current.clear();
      dispatch(setSelectedChat(null));
      navigate('/');
    } catch (err) {
      console.error('handleLogout error:', err.message);
      console.log('Failed to logout, proceeding with client-side cleanup');
      logClientError('Logout failed', err);
      // Proceed with client-side cleanup even if server request fails
      if (socket) {
        socket.emit('leave', userId);
        socket.disconnect();
      }
      sessionStorage.clear();
      localStorage.clear();
      dispatch(resetState());
      setAuth(null, null, null, null, null, null);
      setChatList([]);
      setUnreadMessages({});
      sentStatusesRef.current.clear();
      dispatch(setSelectedChat(null));
      navigate('/');
    }
  }, [socket, userId, setAuth, token, navigate, dispatch, logClientError]);

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
      console.error('getPublicKey error:', err.message);
      if (err.response?.status === 401) {
        console.log('Session expired, please log in again');
        setTimeout(() => handleLogout(), 5000);
      }
      throw new Error('Failed to fetch public key');
    }
  }, [token, handleLogout]);

  const encryptMessage = useCallback(async (content, recipientPublicKey, isMedia = false) => {
    if (!isForgeReady || !forgeRef.current || !recipientPublicKey) {
      const err = new Error('Encryption dependencies missing');
      console.log('Failed to encrypt message');
      throw err;
    }
    try {
      const forge = forgeRef.current;
      const aesKey = forge.random.getBytesSync(32);
      const iv = forge.random.getBytesSync(16);
      const cipher = forge.cipher.createCipher('AES-CBC', aesKey);
      cipher.start({ iv });
      cipher.update(forge.util.createBuffer(isMedia ? content : forge.util.encodeUtf8(content)));
      cipher.finish();
      const encrypted = `${forge.util.encode64(cipher.output.getBytes())}|${encodeURIComponent(forge.util.encode64(iv))}|${encodeURIComponent(
        forge.util.encode64(forge.pki.publicKeyFromPem(recipientPublicKey).encrypt(aesKey, 'RSA-OAEP', { md: forge.md.sha256.create() }))
      )}`;
      return encrypted;
    } catch (err) {
      console.error('encryptMessage error:', err.message);
      console.log('Failed to encrypt message');
      throw new Error('Failed to encrypt message');
    }
  }, [isForgeReady]);

  const fetchChatList = useCallback(async () => {
    if (!isForgeReady) return;
    try {
      const { data } = await axios.get(`${BASE_URL}/social/chat-list`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId },
        timeout: 5000,
      });
      setChatList(data.map((chat) => ({
        ...chat,
        _id: chat.id,
        unreadCount: unreadMessages[chat.id] || chat.unreadCount || 0,
      })));
    } catch (err) {
      throw err; // Let safeRetry handle the error
    }
  }, [isForgeReady, token, userId, unreadMessages]);

  const fetchMessages = useCallback(async (chatId) => {
    if (!isForgeReady || !isValidObjectId(chatId)) return;
    try {
      const { data } = await axios.get(`${BASE_URL}/social/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, recipientId: chatId },
        timeout: 5000,
      });
      dispatch(setMessages({ recipientId: chatId, messages: data.messages }));
      setUnreadMessages((prev) => ({ ...prev, [chatId]: 0 }));
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
      console.error('fetchMessages error:', err.message, err.response?.data);
      console.log(`Failed to load messages: ${err.response?.data?.error || 'Unknown error'}`);
      if (err.response?.status === 401) {
        console.log('Session expired, please log in again');
        setTimeout(() => handleLogout(), 5000);
      }
    }
  }, [isForgeReady, token, userId, socket, dispatch]);

  const sendMessage = useCallback(async () => {
    if (!isForgeReady || !message.trim() || !selectedChat || !isValidObjectId(selectedChat)) return;
    const clientMessageId = generateClientMessageId();
    const plaintextContent = message.trim();
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
          console.error('Socket message error:', ack.error);
          console.log(`Failed to send message: ${ack.error}`);
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
      console.error('sendMessage error:', err.message);
      console.log('Failed to send message');
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
    }
  }, [isForgeReady, message, selectedChat, userId, virtualNumber, username, photo, socket, getPublicKey, encryptMessage, dispatch, chats]);

  const handleAttachment = useCallback(async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile || !selectedChat || !isValidObjectId(selectedChat)) return;
    if (selectedFile.size > 50 * 1024 * 1024) {
      console.log('File size exceeds 50MB limit');
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
      console.error('handleAttachment error:', err.message, err.response?.data);
      console.log(`Failed to upload file: ${err.response?.data?.error || 'Unknown error'}`);
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
    try {
      const response = await axios.post(
        `${BASE_URL}/social/add_contact`,
        { userId, virtualNumber: contactInput.trim() },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      );
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
        return [...prev, newChat];
      });
      setContactInput('');
      setContactError('');
      setShowAddContact(false);
    } catch (err) {
      throw err; // Let safeRetry handle the error
    } finally {
      setIsLoadingAddContact(false);
    }
  }, [contactInput, token, userId]);

  // Handle retries for fetchChatList
  useEffect(() => {
    if (!isForgeReady || !token || !userId) return;
    safeRetry(
      fetchChatList,
      3,
      1000,
      (err) => {
        console.error('fetchChatList failed after retries:', err.message, err.response?.data);
        console.log(`Failed to load chat list: ${err.response?.data?.error || 'Unknown error'}`);
        if (err.response?.status === 401) {
          console.log('Session expired');
          setTimeout(() => handleLogout(), 5000);
        }
      }
    );
  }, [isForgeReady, token, userId, fetchChatList, handleLogout]);

  // Handle retries for handleAddContact
  useEffect(() => {
    if (!isLoadingAddContact || !contactInput.trim()) return;
    safeRetry(
      handleAddContact,
      3,
      1000,
      (err) => {
        console.error('handleAddContact failed after retries:', err.message, err.response?.data);
        setContactError(err.response?.data?.error || 'Failed to add contact');
      }
    );
  }, [isLoadingAddContact, handleAddContact]);

  // Limit sentStatusesRef size
  useEffect(() => {
    if (sentStatusesRef.current.size > maxStatuses) {
      const iterator = sentStatusesRef.current.values();
      for (let i = 0; i < sentStatusesRef.current.size - maxStatuses; i++) {
        sentStatusesRef.current.delete(iterator.next().value);
      }
    }
  }, [chats]);

  useEffect(() => {
    if (!socket || !isForgeReady || !userId) return;

    const handleNewContact = ({ userId: emitterId, contactData }) => {
      if (!contactData?.id || !isValidObjectId(contactData.id)) {
        console.error('Invalid contactData received:', contactData);
        return;
      }
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
        return [...prev, newChat];
      });
    };

    const handleChatListUpdated = ({ userId: emitterId, users }) => {
      if (emitterId !== userId) return;
      setChatList(users.map((chat) => ({
        ...chat,
        _id: chat.id,
        unreadCount: unreadMessages[chat.id] || chat.unreadCount || 0,
      })));
    };

    const handleMessage = (msg) => {
      const senderId = typeof msg.senderId === 'object' ? msg.senderId._id.toString() : msg.senderId.toString();
      const recipientId = typeof msg.recipientId === 'object' ? msg.recipientId._id.toString() : msg.recipientId.toString();
      const targetId = senderId === userId ? recipientId : senderId;
      dispatch(addMessage({ recipientId: targetId, message: msg }));
      if (selectedChat === targetId && document.hasFocus()) {
        if (!sentStatusesRef.current.has(msg._id)) {
          socket.emit('batchMessageStatus', {
            messageIds: [msg._id],
            status: 'read',
            recipientId: userId,
          });
          sentStatusesRef.current.add(msg._id);
        }
        setUnreadMessages((prev) => ({ ...prev, [targetId]: 0 }));
        listRef.current?.scrollToItem((chats[targetId]?.length || 0) + 1, 'end');
      } else {
        setUnreadMessages((prev) => ({ ...prev, [targetId]: (prev[targetId] || 0) + 1 }));
      }
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
      socket.off('contactData');
      socket.off('chatListUpdated');
      socket.off('message');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
      clearTimeout(typingTimeoutRef.current);
      clearTimeout(typingDebounceRef.current);
    };
  }, [socket, isForgeReady, selectedChat, userId, chats, dispatch, unreadMessages]);

  useEffect(() => {
    if (!token || !userId) {
      console.log('Please log in to access chat');
      return;
    }
    if (isForgeReady) {
      socket.emit('join', userId);
      fetchChatList();
    }
  }, [token, userId, isForgeReady, fetchChatList, socket]);

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
    return () => document.removeEventListener('mousedown', handleClickOutside);
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

  const getItemSize = useCallback(
    (index) => {
      const msg = chats[selectedChat]?.[index];
      if (!msg) return 60;
      const isMedia = ['image', 'video', 'audio', 'document'].includes(msg.contentType);
      const baseHeight = 60;
      const mediaHeight = isMedia ? 150 : 0;
      const captionHeight = msg.caption ? 20 : 0;
      return baseHeight + mediaHeight + captionHeight;
    },
    [chats, selectedChat]
  );

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
                    {msg.status === 'pending' ? '⌛' : msg.status === 'sent' ? '✓' : msg.status === 'delivered' ? '✓✓' : '👀'}
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
          {chatList.length === 0 ? (
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
                  src={chatList.find((c) => c.id === selectedChat)?.photo || 'https://placehold.co/40x40'}
                  alt="Avatar"
                  className="conversation-avatar-img"
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