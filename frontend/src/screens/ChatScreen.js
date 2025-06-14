import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import forge from 'node-forge';
import { FaArrowLeft, FaEllipsisV, FaPaperclip, FaSmile, FaPaperPlane, FaTimes, FaSignOutAlt, FaPlus } from 'react-icons/fa';
import { motion, AnimatePresence } from 'framer-motion';
import Picker from 'emoji-picker-react';
import { VariableSizeList } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import './ChatScreen.css';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);
const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

const ChatScreen = React.memo(({ token, userId, setAuth, socket, username, virtualNumber, photo, setSelectedChat }) => {
  const navigate = useNavigate();
  const [chatList, setChatList] = useState([]);
  const [messages, setMessages] = useState({});
  const [selectedChat, setSelectedChatAndNotify] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [contactInput, setContactInput] = useState('');
  const [contactError, setContactError] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAttachmentPicker, setShowAttachmentPicker] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [unreadMessages, setUnreadMessages] = useState({});
  const [isForgeReady, setIsForgeReady] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const menuRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  // Check forge initialization
  useEffect(() => {
    if (forge?.random && forge?.cipher && forge?.pki) {
      setIsForgeReady(true);
    } else {
      setError('Encryption library failed to load');
      console.error('node-forge initialization failed:', forge);
    }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      if (socket) {
        socket.emit('leave', userId);
        await axios.post(`${BASE_URL}/auth/logout`, {}, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        });
        socket.disconnect();
      }
      sessionStorage.clear();
      setAuth('', '', '', '', '', '');
      setChatList([]);
      setMessages({});
      setSelectedChatAndNotify(null);
      navigate('/');
    } catch (err) {
      console.error('handleLogout error:', err.message);
      setError('Failed to logout');
    }
  }, [socket, userId, setAuth, token, navigate]);

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
        setError('Session expired, please log in again');
        setTimeout(() => handleLogout(), 2000);
      }
      throw new Error('Failed to fetch public key: ' + err.message);
    }
  }, [token, handleLogout]);

  const encryptMessage = useCallback(async (content, recipientPublicKey, isMedia = false) => {
    if (!isForgeReady || !recipientPublicKey) {
      console.error('encryptMessage: Dependencies missing', { isForgeReady, recipientPublicKey });
      throw new Error('Encryption dependencies missing');
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
      console.error('encryptMessage error:', err.message);
      throw new Error('Failed to encrypt message: ' + err.message);
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
      setChatList((prev) => {
        const newChatMap = new Map(data.map((chat) => [chat.id, chat]));
        const newList = [...newChatMap.values()];
        return JSON.stringify(newList) === JSON.stringify(prev) ? prev : newList;
      });
      setError('');
    } catch (err) {
      console.error('fetchChatList error:', err.message);
      if (err.response?.status === 401) {
        setError('Session expired, please log in again');
        setTimeout(() => handleLogout(), 2000);
      } else {
        setError('Failed to load chat list: ' + err.message);
      }
    }
  }, [isForgeReady, token, userId, handleLogout]);

  const fetchMessages = useCallback(async (chatId) => {
    if (!isForgeReady || !isValidObjectId(chatId)) return;
    try {
      const { data } = await axios.get(`${BASE_URL}/social/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, recipientId: chatId },
        timeout: 5000,
      });
      setMessages((prev) => ({
        ...prev,
        [chatId]: data.messages,
      }));
      setUnreadMessages((prev) => ({ ...prev, [chatId]: 0 }));
      if (data.messages.length && socket) {
        socket.emit('batchMessageStatus', {
          messageIds: data.messages.filter((m) => m.status !== 'read' && m.recipientId === userId).map((m) => m._id),
          status: 'read',
          recipientId: userId,
        });
      }
      listRef.current?.scrollToItem(data.messages.length, 'end');
    } catch (err) {
      console.error('fetchMessages error:', err.message);
      if (err.response?.status === 401) {
        setError('Session expired, please log in again');
        setTimeout(() => handleLogout(), 2000);
      } else {
        setError('Failed to load messages: ' + err.message);
      }
    }
  }, [isForgeReady, token, userId, socket, handleLogout]);

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
      };
      const tempMessage = {
        _id: clientMessageId,
        ...messageData,
        status: 'pending',
        createdAt: new Date(),
      };
      setMessages((prev) => ({
        ...prev,
        [selectedChat]: [...(prev[selectedChat] || []), tempMessage],
      }));
      socket?.emit('message', messageData, (ack) => {
        if (ack?.error) {
          setError('Failed to send message: ' + ack.error);
          setMessages((prev) => ({
            ...prev,
            [selectedChat]: prev[selectedChat].map((msg) =>
              msg._id === clientMessageId ? { ...msg, status: 'failed' } : msg
            ),
          }));
          return;
        }
        setMessages((prev) => ({
          ...prev,
          [selectedChat]: prev[selectedChat].map((msg) =>
            msg._id === clientMessageId ? { ...ack.message, content: plaintextContent, status: 'sent' } : msg
          ),
        }));
      });
      setMessage('');
      inputRef.current?.focus();
      listRef.current?.scrollToItem((messages[selectedChat]?.length ?? 0) + 1, 'end');
    } catch (err) {
      console.error('sendMessage error:', err.message);
      setError('Failed to send message: ' + err.message);
      setMessages((prev) => ({
        ...prev,
        [selectedChat]: prev[selectedChat].map((msg) =>
          msg._id === clientMessageId ? { ...msg, status: 'failed' } : msg
        ),
      }));
    }
  }, [isForgeReady, message, selectedChat, userId, virtualNumber, username, photo, socket, getPublicKey, encryptMessage]);

  const handleAddContact = useCallback(async () => {
    if (!contactInput.trim()) {
      setContactError('Please enter a valid virtual number');
      return;
    }
    try {
      const response = await axios.post(
        `${BASE_URL}/social/add_contact`,
        { userId, virtualNumber: contactInput.trim() },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      );
      setChatList((prev) => {
        if (prev.find((chat) => chat.id === response.data.id)) return prev;
        return [...prev, { ...response.data, _id: response.data.id }];
      });
      setContactInput('');
      setContactError('');
      setShowAddContact(false);
      socket?.emit('newContact', { userId, contactData: response.data });
    } catch (err) {
      console.error('handleAddContact error:', err.message);
      setContactError(err.response?.data?.error || 'Failed to add contact');
    }
  }, [contactInput, token, userId, socket]);

  // Socket event listeners
  useEffect(() => {
    if (!socket || !isForgeReady) return;

    const handleNewContact = ({ contactData }) => {
      setChatList((prev) => {
        if (prev.find((chat) => chat.id === contactData.id)) return prev;
        return [...prev, { ...contactData, _id: contactData.id }];
      });
    };

    const handleChatListUpdated = ({ users }) => {
      setChatList((prev) => {
        const newChatMap = new Map(users.map((chat) => [chat.id, chat]));
        const newList = [...newChatMap.values()];
        return JSON.stringify(newList) === JSON.stringify(prev) ? prev : newList;
      });
    };

    const handleMessage = (msg) => {
      const senderId = typeof msg.senderId === 'object' ? msg.senderId._id.toString() : msg.senderId.toString();
      setMessages((prev) => {
        const prevMessages = prev[senderId] || [];
        if (prevMessages.some((m) => m._id === msg._id)) return prev;
        return {
          ...prev,
          [senderId]: [...prevMessages, msg],
        };
      });
      if (selectedChat === senderId && document.hasFocus()) {
        socket.emit('batchMessageStatus', { messageIds: [msg._id], status: 'read', recipientId: userId });
        setUnreadMessages((prev) => ({ ...prev, [senderId]: 0 }));
        listRef.current?.scrollToItem((messages[senderId]?.length || 0) + 1, 'end');
      } else {
        setUnreadMessages((prev) => ({ ...prev, [senderId]: (prev[senderId] || 0) + 1 }));
      }
    };

    const handleTyping = ({ userId: typingUserId }) => {
      if (typingUserId === selectedChat) {
        setIsTyping((prev) => ({ ...prev, [typingUserId]: true }));
        setTimeout(() => setIsTyping((prev) => ({ ...prev, [typingUserId]: false })), 3000);
      }
    };

    const handleStopTyping = ({ userId: typingUserId }) => {
      if (typingUserId === selectedChat) {
        setIsTyping((prev) => ({ ...prev, [typingUserId]: false }));
      }
    };

    const handleMessageStatus = ({ messageIds, status }) => {
      setMessages((prev) => {
        const updatedMessages = { ...prev };
        Object.keys(updatedMessages).forEach((chatId) => {
          updatedMessages[chatId] = updatedMessages[chatId].map((msg) =>
            messageIds.includes(msg._id) && msg.senderId.toString() === userId ? { ...msg, status } : msg
          );
        });
        return JSON.stringify(updatedMessages) === JSON.stringify(prev) ? prev : updatedMessages;
      });
    };

    socket.on('newContact', handleNewContact);
    socket.on('chatListUpdated', handleChatListUpdated);
    socket.on('message', handleMessage);
    socket.on('typing', handleTyping);
    socket.on('stopTyping', handleStopTyping);
    socket.on('messageStatus', handleMessageStatus);

    return () => {
      socket.off('newContact');
      socket.off('chatListUpdated');
      socket.off('message');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
    };
  }, [socket, isForgeReady, selectedChat, userId, messages]);

  // Initial setup
  useEffect(() => {
    if (!token || !userId || !isForgeReady) {
      navigate('/');
      return;
    }
    fetchChatList();
  }, [token, userId, isForgeReady, navigate, fetchChatList]);

  // Fetch messages for selected chat
  useEffect(() => {
    if (selectedChat && !messages[selectedChat]) {
      fetchMessages(selectedChat);
    }
  }, [selectedChat, fetchMessages]);

  // Handle click outside menu
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowMenu(false);
        setShowAddContact(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced typing handler
  const handleTyping = useCallback(() => {
    if (!socket || !selectedChat) return;
    clearTimeout(typingTimeoutRef.current);
    socket.emit('typing', { userId, recipientId: selectedChat });
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stopTyping', { userId, recipientId: selectedChat });
    }, 3000);
  }, [socket, selectedChat, userId]);

  const selectChat = useCallback((chatId) => {
    setSelectedChatAndNotify(chatId);
    setSelectedChat(chatId);
    setShowMenu(false);
    setError('');
    if (chatId && socket) {
      socket.emit('batchMessageStatus', {
        messageIds: (messages[chatId] || []).filter((m) => m.status !== 'read' && m.recipientId.toString() === userId).map((m) => m._id),
        status: 'read',
        recipientId: userId,
      });
      setUnreadMessages((prev) => ({ ...prev, [chatId]: 0 }));
    }
    inputRef.current?.focus();
  }, [socket, messages, userId, setSelectedChatAndNotify]);

  // Calculate dynamic item size for messages
  const getItemSize = useCallback((index) => {
    const msg = messages[selectedChat]?.[index];
    if (!msg) return 60;
    const isMedia = ['image', 'video', 'audio', 'document'].includes(msg.contentType);
    const baseHeight = 60;
    const mediaHeight = isMedia ? 150 : 0;
    const captionHeight = msg.caption ? 20 : 0;
    return baseHeight + mediaHeight + captionHeight;
  }, [messages, selectedChat]);

  // Memoized message rendering component
  const Row = useMemo(() => {
    const Component = ({ index, style }) => {
      const msg = messages[selectedChat]?.[index];
      if (!msg) return null;
      const prevMsg = index > 0 ? messages[selectedChat][index - 1] : null;
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
    };
    Component.displayName = 'MessageRow';
    return React.memo(Component);
  }, [messages, selectedChat, userId]);

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
                        placeholder="Enter virtual number (e.g., +25534567890)"
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
                      disabled={!contactInput.trim()}
                    >
                      Add Contact
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      {error && <div className="error-message">{error}</div>}
      <div className="chat-content">
        <div className={`chat-list ${selectedChat ? 'hidden md:block' : 'block'}`}>
          {chatList.map((chat) => (
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
                {!!unreadMessages[chat.id] && (
                  <span className="chat-list-unread">{unreadMessages[chat.id]}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className={`chat-conversation ${selectedChat ? 'block' : 'hidden md:block'}`}>
          {selectedChat ? (
            <>
              <div className="conversation-header">
                <FaArrowLeft className="back-icon md:hidden" onClick={() => selectChat(null)} />
                <img
                  src={chatList.find((c) => c.id === selectedChat)?.photo || 'https://placehold.co/40x40'}
                  alt="Avatar"
                  className="conversation-avatar"
                />
                <div className="conversation-info">
                  <h2 className="title">{chatList.find((c) => c.id === selectedChat)?.username}</h2>
                  {isTyping[selectedChat] && <span className="typing-indicator">Typing...</span>}
                </div>
              </div>
              <div className="conversation-messages">
                {messages[selectedChat]?.length ? (
                  <AutoSizer>
                    {({ height, width }) => (
                      <VariableSizeList
                        ref={listRef}
                        height={height}
                        width={width}
                        itemCount={messages[selectedChat].length}
                        itemSize={getItemSize}
                        initialScrollOffset={messages[selectedChat].length * 60}
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
                    className="emoji-picker"
                  />
                )}
                <FaPaperclip
                  className="attachment-icon"
                  onClick={() => setShowAttachmentPicker(!showAttachmentPicker)}
                />
                {showAttachmentPicker && (
                  <div className="attachment-picker">
                    <FaImage className="picker-item" />
                    <FaVideo className="picker-item" />
                    <FaFile className="picker-item" />
                    <FaMusic className="picker-item" />
                  </div>
                )}
                <input
                  ref={inputRef}
                  type="text"
                  className="message-input"
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