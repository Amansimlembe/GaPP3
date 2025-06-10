
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { FaArrowLeft, FaEllipsisV, FaPaperclip, FaSmile, FaPaperPlane, FaTimes, FaSignOutAlt, FaPlus } from 'react-icons/fa';
import { motion, AnimatePresence } from 'framer-motion';
import Picker from 'emoji-picker-react';
import { FixedSizeList } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import './ChatScreen.css';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

const ChatScreen = ({ token, userId, setAuth, socket, username, virtualNumber, photo, setSelectedChat }) => {
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
  const [isCryptoReady, setIsCryptoReady] = useState(false);
  const [forge, setForge] = useState(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const menuRef = useRef(null);

  // Dynamically load node-forge
  useEffect(() => {
    let isMounted = true;
    import('node-forge')
      .then((module) => {
        if (isMounted) {
          setForge(module.default || module);
          if (module.random && module.cipher && module.pki && module.util && module.md) {
            setIsCryptoReady(true);
            console.debug('node-forge loaded successfully');
          } else {
            setError('Encryption library incomplete');
            console.error('node-forge missing required modules:', module);
          }
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError('Failed to load encryption library');
          console.error('node-forge load error:', err.message);
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const encryptMessage = useCallback(async (content, recipientPublicKey, isMedia = false) => {
    if (!isCryptoReady || !forge || !recipientPublicKey) {
      console.error('encryptMessage: Dependencies missing', { isCryptoReady, forge: !!forge, recipientPublicKey });
      throw new Error('Encryption dependencies missing');
    }
    try {
      console.debug('encryptMessage called', { contentLength: content?.length, isMedia });
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
  }, [isCryptoReady, forge]);

  const decryptMessage = useCallback(async (encryptedContent, privateKeyPem, isMedia = false) => {
    if (!isCryptoReady || !forge || !encryptedContent || !privateKeyPem) {
      console.error('decryptMessage: Dependencies missing', { isCryptoReady, forge: !!forge, encryptedContent, privateKeyPem });
      return isMedia ? null : '[Decryption failed]';
    }
    try {
      console.debug('decryptMessage called', { encryptedContentLength: encryptedContent?.length, isMedia });
      if (typeof encryptedContent !== 'string' || !encryptedContent.includes('|')) {
        throw new Error('Invalid encrypted content format');
      }
      const [encryptedData, iv, encryptedAesKey] = encryptedContent.split('|').map(forge.util.decode64);
      const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
      const aesKey = privateKey.decrypt(encryptedAesKey, 'RSA-OAEP', { md: forge.md.sha256.create() });
      const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
      decipher.start({ iv });
      decipher.update(forge.util.createBuffer(encryptedData));
      decipher.finish();
      return isMedia ? decipher.output.getBytes() : forge.util.decodeUtf8(decipher.output.getBytes());
    } catch (err) {
      console.error('decryptMessage error:', err.message);
      return isMedia ? null : '[Decryption failed]';
    }
  }, [isCryptoReady, forge]);

  const getPublicKey = useCallback(async (recipientId) => {
    if (!isValidObjectId(recipientId)) throw new Error('Invalid recipientId');
    const cacheKey = `publicKey:${recipientId}`;
    const cachedKey = sessionStorage.getItem(cacheKey);
    if (cachedKey) {
      console.debug('getPublicKey: Using cached key', { recipientId });
      return cachedKey;
    }
    try {
      const { data } = await axios.get(`${BASE_URL}/auth/public_key/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });
      if (!data.publicKey) throw new Error('No public key returned');
      console.debug('getPublicKey: Fetched key', { recipientId, publicKey: data.publicKey.substring(0, 30) + '...' });
      sessionStorage.setItem(cacheKey, data.publicKey);
      return data.publicKey;
    } catch (err) {
      console.error('getPublicKey error:', err.message);
      throw new Error('Failed to fetch public key: ' + err.message);
    }
  }, [token]);

  const fetchChatList = useCallback(async () => {
    if (!isCryptoReady || !forge) {
      console.warn('fetchChatList: Waiting for encryption library');
      return;
    }
    try {
      const privateKey = sessionStorage.getItem('privateKey');
      if (!privateKey) throw new Error('Private key missing');
      console.debug('fetchChatList: Fetching chat list', { userId });
      const { data } = await axios.get(`${BASE_URL}/social/chat-list`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId },
        timeout: 5000,
      });
      const processedUsers = await Promise.all(
        data.map(async (user) => {
          if (user.latestMessage) {
            user.latestMessage.content =
              user.latestMessage.senderId === userId
                ? `You: ${user.latestMessage.plaintextContent || '[Media]'}` 
                : user.latestMessage.recipientId === userId && user.latestMessage.contentType === 'text'
                ? await decryptMessage(user.latestMessage.content, privateKey)
                : `[${user.latestMessage.contentType}]`;
          }
          return user;
        })
      );
      setChatList((prev) => {
        const newChatMap = new Map(processedUsers.map((chat) => [chat.id, chat]));
        return [...newChatMap.values()];
      });
      setError('');
    } catch (err) {
      console.error('fetchChatList error:', err.message);
      if (err.response?.status === 401 || err.message === 'Private key missing') {
        setError('Session expired, please log in again');
        setTimeout(() => handleLogout(), 2000);
      } else {
        setError('Failed to load chat list: ' + err.message);
      }
    }
  }, [isCryptoReady, forge, token, userId, decryptMessage, handleLogout]);

  const fetchMessages = useCallback(async (chatId) => {
    if (!isCryptoReady || !forge || !isValidObjectId(chatId)) return;
    try {
      const privateKey = sessionStorage.getItem('privateKey');
      if (!privateKey) throw new Error('Private key missing');
      console.debug('fetchMessages: Fetching messages', { chatId });
      const { data } = await axios.get(`${BASE_URL}/social/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, chatId },
        timeout: 5000,
      });
      const decryptedMessages = await Promise.all(
        data.messages.map(async (msg) => {
          if (msg.senderId !== userId && msg.contentType === 'text') {
            msg.content = await decryptMessage(msg.content, privateKey);
          }
          return msg;
        })
      );
      setMessages((prev) => ({
        ...prev,
        [chatId]: decryptedMessages,
      }));
      setUnreadMessages((prev) => ({ ...prev, [chatId]: 0 }));
      if (decryptedMessages.length) {
        socket?.emit('batchMessageStatus', {
          messageIds: decryptedMessages.filter((m) => m.status !== 'read' && m.recipientId === userId).map((m) => m._id),
          status: 'read',
          recipientId: userId,
        });
      }
      listRef.current?.scrollToItem(decryptedMessages.length, 'end');
    } catch (err) {
      console.error('fetchMessages error:', err.message);
      setError('Failed to load messages: ' + err.message);
    }
  }, [isCryptoReady, forge, token, userId, socket, decryptMessage]);

  const sendMessage = useCallback(async () => {
    if (!isCryptoReady || !forge || !message.trim() || !selectedChat || !isValidObjectId(selectedChat)) return;
    const clientMessageId = generateClientMessageId();
    const plaintextContent = message.trim();
    try {
      const recipientPublicKey = await getPublicKey(selectedChat);
      if (!recipientPublicKey) throw new Error('Recipient public key not found');
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
      listRef.current?.scrollToItem(messages[selectedChat]?.length ?? 0, 'end');
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
  }, [isCryptoReady, forge, message, selectedChat, userId, virtualNumber, username, photo, socket, getPublicKey, encryptMessage]);

  const handleAddContact = async () => {
    if (!contactInput.trim()) {
      setContactError('Please enter a valid virtual number');
      return;
    }
    try {
      console.debug('handleAddContact: Adding contact', { virtualNumber: contactInput });
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
  };

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

  useEffect(() => {
    if (!token || !userId || !isCryptoReady) {
      if (!isCryptoReady) console.warn('useEffect: Waiting for encryption library');
      navigate('/');
      return;
    }
    const privateKey = sessionStorage.getItem('privateKey');
    if (!privateKey) {
      setError('Private key missing, please log in again');
      setTimeout(() => handleLogout(), 2000);
    } else {
      fetchChatList();
    }
  }, [isCryptoReady, fetchChatList, handleLogout, token, userId, navigate]);

  useEffect(() => {
    if (selectedChat && !messages[selectedChat]) {
      fetchMessages(selectedChat);
    }
  }, [selectedChat, fetchMessages]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowMenu(false);
        setShowAddContact(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!socket || !isCryptoReady) return;

    socket.on('newContact', ({ contactData }) => {
      console.debug('Socket: newContact', { contactId: contactData.id });
      setChatList((prev) => {
        if (prev.find((chat) => chat.id === contactData.id)) return prev;
        return [...prev, { ...contactData, _id: contactData.id }];
      });
    });

    socket.on('chatListUpdated', ({ users }) => {
      console.debug('Socket: chatListUpdated', { userCount: users.length });
      setChatList((prev) => {
        const newChatMap = new Map(users.map((chat) => [chat.id, chat]));
        return [...newChatMap.values()];
      });
    });

    socket.on('message', async (msg) => {
      const senderId = typeof msg.senderId === 'object' ? msg.senderId._id.toString() : msg.senderId.toString();
      const privateKey = sessionStorage.getItem('privateKey');
      if (!privateKey || !isCryptoReady || !forge) {
        setError('Private key missing or encryption not ready, please log in again');
        console.error('Socket message: Dependencies missing', { privateKey: !!privateKey, isCryptoReady, forge: !!forge });
        return;
      }
      try {
        console.debug('Socket: message received', { senderId, contentType: msg.contentType });
        const decryptedContent = msg.contentType === 'text' ? await decryptMessage(msg.content, privateKey) : msg.content;
        setMessages((prev) => ({
          ...prev,
          [senderId]: [...(prev[senderId] || []), { ...msg, content: decryptedContent }],
        }));
        if (selectedChat === senderId) {
          socket.emit('batchMessageStatus', { messageIds: [msg._id], status: 'read', recipientId: userId });
          setUnreadMessages((prev) => ({ ...prev, [senderId]: 0 }));
          listRef.current?.scrollToItem(messages[senderId]?.length || 0, 'end');
        } else {
          setUnreadMessages((prev) => ({ ...prev, [senderId]: (prev[senderId] || 0) + 1 }));
        }
      } catch (err) {
        console.error('Socket message handler error:', err.message);
      }
    });

    socket.on('typing', ({ userId: typingUserId }) => {
      if (typingUserId === selectedChat) {
        setIsTyping((prev) => ({ ...prev, [typingUserId]: true }));
        setTimeout(() => setIsTyping((prev) => ({ ...prev, [typingUserId]: false })), 3000);
      }
    });

    socket.on('stopTyping', ({ userId: typingUserId }) => {
      if (typingUserId === selectedChat) {
        setIsTyping((prev) => ({ ...prev, [typingUserId]: false }));
      }
    });

    socket.on('messageStatus', ({ messageIds, status }) => {
      console.debug('Socket: messageStatus', { messageIds, status });
      setMessages((prev) => {
        const updatedMessages = { ...prev };
        Object.keys(updatedMessages).forEach((chatId) => {
          updatedMessages[chatId] = updatedMessages[chatId].map((msg) =>
            messageIds.includes(msg._id) && msg.senderId === userId ? { ...msg, status } : msg
          );
        });
        return updatedMessages;
      });
    });

    return () => {
      socket.off('newContact');
      socket.off('chatListUpdated');
      socket.off('message');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
    };
  }, [socket, isCryptoReady, forge, selectedChat, userId, messages, decryptMessage]);

  const handleTyping = useCallback(() => {
    if (socket && selectedChat) {
      socket.emit('typing', { userId, recipientId: selectedChat });
      setTimeout(() => socket.emit('stopTyping', { userId, recipientId: selectedChat }), 3000);
    }
  }, [socket, selectedChat, userId]);

  const selectChat = (chatId) => {
    setSelectedChatAndNotify(chatId);
    setSelectedChat(chatId);
    setShowMenu(false);
    setError('');
    if (chatId && socket) {
      socket.emit('batchMessageStatus', {
        messageIds: (messages[chatId] || []).filter((m) => m.status !== 'read' && m.recipientId === userId).map((m) => m._id),
        status: 'read',
        recipientId: userId,
      });
    }
    inputRef.current?.focus();
  };

  const renderMessage = ({ index, style }) => {
    const msg = messages[selectedChat][index];
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
            <p className="message-content">{msg.content}</p>
            <div className="message-meta">
              <span className="timestamp">{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              {isMine && (
                <span className="message-status">
                  {msg.status === 'pending' ? '⌛' : msg.status === 'sent' ? '✓' : '✓✓'}
                </span>
              )}
            </div>
          </div>
        </div>
      </>
    );
  };

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
              key={chat._id}
              className={`chat-list-item ${selectedChat === chat._id ? 'selected' : ''}`}
              onClick={() => selectChat(chat._id)}
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
                  <p className="chat-list-preview">{chat.latestMessage.content}</p>
                )}
                {!!unreadMessages[chat._id] && (
                  <span className="chat-list-unread">{unreadMessages[chat._id]}</span>
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
                  src={chatList.find((c) => c._id === selectedChat)?.photo || 'https://placehold.co/40x40'}
                  alt="Avatar"
                  className="conversation-avatar"
                />
                <div className="conversation-info">
                  <h2 className="title">{chatList.find((c) => c._id === selectedChat)?.username}</h2>
                  {isTyping[selectedChat] && <span className="typing-indicator">Typing...</span>}
                </div>
              </div>
              <div className="conversation-messages">
                {messages[selectedChat]?.length ? (
                  <AutoSizer>
                    {({ height, width }) => (
                      <FixedSizeList
                        ref={listRef}
                        height={height}
                        width={width}
                        itemCount={messages[selectedChat].length}
                        itemSize={60}
                      >
                        {renderMessage}
                      </FixedSizeList>
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
};

export default ChatScreen;
