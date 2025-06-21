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
import {
  setMessages,
  addMessage,
  replaceMessage,
  updateMessageStatus,
  setSelectedChat,
  resetState,
  setChatList,
  addContact,
  setMessagesError,
} from '../store';
import './ChatScreen.css';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);
const isValidVirtualNumber = (number) => /^\+\d{7,15}$/.test(number.trim());
const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

const ChatScreen = React.memo(({ token, userId, setAuth, socket, username, virtualNumber, photo, privateKey, onUnauthorized }) => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { selectedChat, chats, chatList, error: messagesError } = useSelector((state) => state.messages);
  const { privateKey: userPrivateKey } = useSelector((state) => state.auth);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [contactInput, setContactInput] = useState('');
  const [contactError, setContactError] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAttachmentPicker, setShowAttachmentPicker] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [isForgeReady, setIsForgeReady] = useState(false);
  const [isLoadingChatList, setIsLoadingChatList] = useState(true);
  const [isLoadingAddContact, setIsLoadingAddContact] = useState(false);
  const [file, setFile] = useState(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const listRef = useRef(null);
  const menuRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const typingDebounceRef = useRef(null);
  const sentStatusesRef = useRef(new Set());
  const retryCountRef = useRef({ chatList: 0, addContact: 0 });
  const maxRetries = 3;

  // Combine errors from Redux and local state
  const error = messagesError || localError;

  useEffect(() => {
    if (forge?.random && forge?.cipher && forge?.pki) {
      setIsForgeReady(true);
      setIsLoadingChatList(true);
    } else {
      dispatch(setMessagesError('Encryption library failed to load'));
      console.error('node-forge initialization failed:', forge);
      logClientError('node-forge initialization failed', new Error('Forge not loaded'));
      setIsLoadingChatList(false);
    }
  }, [dispatch]);

  const logClientError = useCallback(async (message, error) => {
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
    } catch (err) {
      console.error('Failed to log client error:', err.message);
    }
  }, [userId]);

  const decryptMessage = useCallback(
    async (encryptedContent, privateKeyPem) => {
      if (!isForgeReady || !privateKeyPem) {
        console.error('Decryption dependencies missing');
        return '[Message not decrypted]';
      }
      try {
        const [encryptedData, iv, encryptedKey] = encryptedContent.split('|').map(forge.util.decode64);
        const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
        const aesKey = privateKey.decrypt(encryptedKey, 'RSA-OAEP', { md: forge.md.sha256.create() });
        const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
        decipher.start({ iv });
        decipher.update(forge.util.createBuffer(encryptedData));
        if (!decipher.finish()) {
          throw new Error('Decryption failed');
        }
        return decipher.output.toString('utf8');
      } catch (err) {
        console.error('decryptMessage error:', err.message);
        logClientError('Decryption failed', err);
        return '[Message not decrypted]';
      }
    },
    [isForgeReady, logClientError]
  );

  const getPublicKey = useCallback(
    async (recipientId) => {
      if (!isValidObjectId(recipientId)) {
        throw new Error('Invalid recipientId');
      }
      const cacheKey = `publicKey:${recipientId}`;
      const cachedKey = sessionStorage.getItem(cacheKey);
      if (cachedKey) {
        return cachedKey;
      }
      try {
        const { data } = await axios.get(`${BASE_URL}/auth/public_key/${recipientId}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        });
        if (!data.publicKey) {
          throw new Error('No public key returned');
        }
        sessionStorage.setItem(cacheKey, data.publicKey);
        return data.publicKey;
      } catch (err) {
        console.error('getPublicKey error:', err.message);
        logClientError('Failed to fetch public key', err);
        if (err.response?.status === 401) {
          onUnauthorized();
        }
        throw err;
      }
    },
    [token, onUnauthorized, logClientError]
  );

  const encryptMessage = useCallback(
    async (content, recipientPublicKey, isMedia = false) => {
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
        if (!cipher.finish()) {
          throw new Error('Encryption failed');
        }
        const encrypted = `${forge.util.encode64(cipher.output.getBytes())}|${forge.util.encode64(iv)}|${forge.util.encode64(
          forge.pki.publicKeyFromPem(recipientPublicKey).encrypt(aesKey, 'RSA-OAEP', { md: forge.md.sha256.create() })
        )}`;
        return encrypted;
      } catch (err) {
        console.error('encryptMessage error:', err.message);
        logClientError('Encryption failed', err);
        throw err;
      }
    },
    [isForgeReady, logClientError]
  );

  const fetchChatList = useCallback(
    async (isRetry = false) => {
      if (!isForgeReady) {
        return;
      }
      setIsLoadingChatList(true);
      try {
        const { data } = await axios.get(`${BASE_URL}/social/chat-list`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId },
          timeout: 5000,
        });
        dispatch(setChatList(data));
        setLocalError('');
        retryCountRef.current.chatList = 0;
      } catch (err) {
        console.error('ChatList fetch error:', err.message, err.response?.data);
        logClientError('Chat list fetch failed', err);
        if (err.response?.status === 401) {
          onUnauthorized();
        } else if (err.response?.status === 500 && !isRetry && retryCountRef.current.chatList < maxRetries) {
          retryCountRef.current.chatList += 1;
          setTimeout(
            () => fetchChatList(true),
            1000 * Math.pow(2, retryCountRef.current.chatList) // Exponential backoff
          );
          dispatch(setMessagesError(`Retrying chat list fetch (${retryCountRef.current.chatList}/${maxRetries})...`));
        } else {
          dispatch(setMessagesError(`Failed to load chat list: ${err.response?.data?.error || 'Unknown error'}. Click to retry...`));
          retryCountRef.current.chatList = 0;
        }
      } finally {
        setIsLoadingChatList(false);
      }
    },
    [isForgeReady, token, userId, dispatch, onUnauthorized, logClientError]
  );

  const fetchMessages = useCallback(
    async (chatId) => {
      if (!isForgeReady || !isValidObjectId(chatId)) {
        return;
      }
      try {
        const { data } = await axios.get(`${BASE_URL}/social/messages`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId: chatId },
          timeout: 5000,
        });
        // Decrypt messages
        const decryptedMessages = await Promise.all(
          data.messages.map(async (msg) => {
            if (msg.contentType !== 'text' || !msg.content.includes('|')) {
              return msg;
            }
            const plaintextContent = msg.senderId.toString() !== userId ? await decryptMessage(msg.content, userPrivateKey) : msg.plaintextContent;
            return { ...msg, plaintextContent };
          })
        );
        dispatch(setMessages({ recipientId: chatId, messages: decryptedMessages }));
        const unreadMessageIds = decryptedMessages
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
        listRef.current?.scrollToItem(decryptedMessages.length, 'end');
        setLocalError('');
      } catch (err) {
        console.error('fetchMessages error:', err.message, err.response?.data);
        logClientError('Messages fetch failed', err);
        if (err.response?.status === 401) {
          onUnauthorized();
        } else {
          dispatch(setMessagesError(`Failed to load messages: ${err.response?.data?.error || 'Unknown error'}`));
        }
      }
    },
    [isForgeReady, token, userId, socket, dispatch, userPrivateKey, onUnauthorized, decryptMessage, logClientError]
  );

  const sendMessage = useCallback(
    async () => {
      if (!isForgeReady || !message.trim() || !selectedChat || !isValidObjectId(selectedChat)) {
        return;
      }
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
          createdAt: new Date().toISOString(),
        };
        dispatch(addMessage({ recipientId: selectedChat, message: messageData }));
        socket?.emit('message', messageData, (ack) => {
          if (ack?.error) {
            console.error('Socket message error:', ack.error);
            dispatch(setMessagesError(`Failed to send message: ${ack.error}`));
            dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
            logClientError('Socket message failed', new Error(ack.error));
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
        dispatch(setMessagesError('Failed to send message'));
        dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
        logClientError('Send message failed', err);
      }
    },
    [isForgeReady, message, selectedChat, userId, virtualNumber, username, photo, socket, getPublicKey, encryptMessage, dispatch, chats, logClientError]
  );

  const handleAttachment = useCallback(
    async (e) => {
      const selectedFile = e.target.files[0];
      if (!selectedFile || !selectedChat || !isValidObjectId(selectedChat)) {
        return;
      }
      if (selectedFile.size > 50 * 1024 * 1024) {
        dispatch(setMessagesError('File size exceeds 50MB limit'));
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
          contentType: selectedFile.type.startsWith('image/') ? 'image' : selectedFile.type.startsWith('video/') ? 'video' : selectedFile.type.startsWith('audio/') ? 'audio' : 'document',
          originalFilename: selectedFile.name,
          clientMessageId,
          status: 'pending',
          createdAt: new Date().toISOString(),
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
        dispatch(setMessagesError(`Failed to upload file: ${err.response?.data?.error || 'Unknown error'}`));
        dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
        logClientError('File upload failed', err);
        if (err.response?.status === 401) {
          onUnauthorized();
        }
      }
    },
    [selectedChat, userId, virtualNumber, username, photo, token, dispatch, chats, onUnauthorized, logClientError]
  );

  const handleAddContact = useCallback(
    async () => {
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
        dispatch(addContact(response.data));
        setContactInput('');
        setContactError('');
        setShowAddContact(false);
        setLocalError('');
        retryCountRef.current.addContact = 0;
      } catch (err) {
        console.error('handleAddContact error:', err.message, err.response?.data);
        logClientError('Add contact failed', err);
        const errorMsg = err.response?.data?.error || 'Failed to add contact';
        if (err.response?.status === 401) {
          onUnauthorized();
        } else if (err.response?.status === 500 && retryCountRef.current.addContact < maxRetries) {
          retryCountRef.current.addContact += 1;
          setTimeout(
            () => handleAddContact(),
            1000 * Math.pow(2, retryCountRef.current.addContact) // Exponential backoff
          );
          setContactError(`Retrying (${retryCountRef.current.addContact}/${maxRetries})...`);
        } else {
          setContactError(errorMsg);
          retryCountRef.current.addContact = 0;
        }
      } finally {
        setIsLoadingAddContact(false);
      }
    },
    [contactInput, token, userId, dispatch, onUnauthorized, logClientError]
  );

  useEffect(() => {
    if (!socket || !isForgeReady || !userId) {
      return;
    }

    socket.emit('join', userId);

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
      console.log('Received messageStatus:', { messageIds, status });
      messageIds.forEach((messageId) => {
        Object.keys(chats).forEach((chatId) => {
          if (chats[chatId].some((msg) => msg._id === messageId && msg.senderId.toString() === userId)) {
            dispatch(updateMessageStatus({ recipientId: chatId, messageId, status }));
          }
        });
      });
    };

    socket.on('typing', handleTyping);
    socket.on('stopTyping', handleStopTyping);
    socket.on('messageStatus', handleMessageStatus);

    return () => {
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
    };
  }, [socket, isForgeReady, selectedChat, userId, chats, dispatch]);

  useEffect(() => {
    if (!token || !userId) {
      dispatch(setMessagesError('Please log in to access chat'));
      setIsLoadingChatList(false);
      return;
    }
    if (isForgeReady) {
      fetchChatList();
    }
  }, [token, userId, isForgeReady, fetchChatList, dispatch]);

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

  const handleTyping = useCallback(() => {
    if (!socket || !selectedChat) {
      return;
    }
    clearTimeout(typingDebounceRef.current);
    typingDebounceRef.current = setTimeout(() => {
      socket.emit('typing', { userId, recipientId: selectedChat });
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        socket.emit('stopTyping', { userId, recipientId: selectedChat });
      }, 3000);
    }, 500);
  }, [socket, selectedChat, userId]);

  const selectChat = useCallback(
    (chatId) => {
      dispatch(setSelectedChat(chatId));
      setShowMenu(false);
      setLocalError('');
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
      }
      inputRef.current?.focus();
    },
    [socket, chats, userId, dispatch]
  );

  const getItemSize = useCallback(
    (index) => {
      const msg = chats[selectedChat]?.[index];
      if (!msg) {
        return 60;
      }
      const isMedia = ['image', 'video', 'audio', 'document'].includes(msg.contentType);
      const baseHeight = 60;
      const mediaHeight = isMedia ? 150 : 0;
      const captionHeight = msg.caption ? 20 : 0;
      return baseHeight + mediaHeight + captionHeight;
    },
    [chats, selectedChat]
  );

  const Row = useMemo(
    () =>
      ({ index, style }) => {
        const msg = chats[selectedChat]?.[index];
        if (!msg) {
          return null;
        }
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
    return <div className="chat-screen">Encryption library failed to load</div>;
  }

  return (
    <div className="chat-screen">
      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <div className="error-actions">
            {error.includes('retry') && (
              <button className="retry-button bg-primary text-white px-4 py-2 rounded" onClick={() => fetchChatList()}>
                Retry
              </button>
            )}
            <FaTimes className="dismiss-icon" onClick={() => dispatch(setMessagesError(null))} />
          </div>
        </div>
      )}
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
                <div className="menu-item logout" onClick={onUnauthorized}>
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
                      {contactInput && <FaTimes className="clear-input-icon" onClick={() => setContactInput('')} />}
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
            <div className="loading-screen">Loading contacts...</div>
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
                <img src={chat.photo || 'https://placehold.co/40x40'} alt="Avatar" className="chat-list-avatar" />
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
                  {!!chat.unreadCount && <span className="chat-list-unread">{chat.unreadCount}</span>}
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
                <FaSmile className="emoji-icon" onClick={() => setShowEmojiPicker(!showEmojiPicker)} />
                {showEmojiPicker && (
                  <Picker
                    onEmojiClick={(emojiObject) => {
                      setMessage((prev) => prev + emojiObject.emoji);
                      setShowEmojiPicker(false);
                    }}
                  />
                )}
                <FaPaperclip className="attachment-icon" onClick={() => setShowAttachmentPicker(!showAttachmentPicker)} />
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