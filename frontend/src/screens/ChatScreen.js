import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import forge from 'node-forge';
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
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const menuRef = useRef(null);

  const encryptMessage = useCallback(async (content, recipientPublicKey, isMedia = false) => {
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
      console.log('Message encrypted successfully');
      return encrypted;
    } catch (err) {
      console.error('Encryption error:', err);
      throw new Error('Failed to encrypt message');
    }
  }, []);

  const decryptMessage = useCallback(async (encryptedContent, privateKeyPem, isMedia = false) => {
    try {
      if (!encryptedContent || typeof encryptedContent !== 'string' || !encryptedContent.includes('|')) {
        throw new Error('Invalid encrypted content format');
      }
      const [encryptedData, iv, encryptedAesKey] = encryptedContent.split('|').map(forge.util.decode64);
      const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
      const aesKey = privateKey.decrypt(encryptedAesKey, 'RSA-OAEP', { md: forge.md.sha256.create() });
      const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
      decipher.start({ iv });
      decipher.update(forge.util.createBuffer(encryptedData));
      decipher.finish();
      const decrypted = isMedia ? decipher.output.getBytes() : forge.util.decodeUtf8(decipher.output.getBytes());
      console.log('Message decrypted successfully');
      return decrypted;
    } catch (err) {
      console.error('Decryption error:', err);
      return isMedia ? null : '[Decryption failed]';
    }
  }, []);

  const getPublicKey = useCallback(async (recipientId) => {
    if (!isValidObjectId(recipientId)) {
      throw new Error('Invalid recipientId');
    }
    const cacheKey = `publicKey:${recipientId}`;
    const cachedKey = sessionStorage.getItem(cacheKey);
    if (cachedKey) return cachedKey;
    try {
      const { data } = await axios.get(`${BASE_URL}/auth/public_key/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      sessionStorage.setItem(cacheKey, data.publicKey);
      console.log(`Public key fetched for ${recipientId}`);
      return data.publicKey;
    } catch (err) {
      console.error(`Failed to fetch public key for ${recipientId}:`, err);
      throw err;
    }
  }, [token]);

  const fetchChatList = useCallback(async () => {
    try {
      const privateKey = sessionStorage.getItem('privateKey');
      if (!privateKey) {
        throw new Error('Private key missing');
      }
      const { data } = await axios.get(`${BASE_URL}/social/chat-list`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId },
        timeout: 10000,
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
      setChatList(processedUsers);
      setError('');
      if (socket) {
        socket.emit('chatListUpdated', { userId, users: processedUsers });
      }
    } catch (err) {
      console.error('Fetch chat list failed:', err);
      if (err.response?.status === 401 || err.message === 'Private key missing') {
        setError('Session expired, please log in again');
        setTimeout(() => handleLogout(), 2000);
      } else {
        setError('Failed to load chat list');
      }
    }
  }, [token, userId, socket]);

  const fetchMessages = useCallback(async (chatId) => {
    if (!isValidObjectId(chatId)) {
      setError('Invalid chat ID');
      return;
    }
    try {
      const privateKey = sessionStorage.getItem('privateKey');
      if (!privateKey) {
        throw new Error('Private key missing');
      }
      const { data } = await axios.get(`${BASE_URL}/social/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, chatId },
        timeout: 10000,
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
      if (data.unreadCount > 0) {
        socket?.emit('readMessages', { chatId, userId });
        setUnreadMessages((prev) => ({ ...prev, [chatId]: 0 }));
      }
      listRef.current?.scrollToItem(decryptedMessages.length, 'end');
    } catch (err) {
      console.error('Fetch messages failed:', err);
      setError('Failed to load messages');
    }
  }, [token, userId, socket]);

  const sendMessage = useCallback(async () => {
    if (!message.trim() || !selectedChat || !isValidObjectId(selectedChat)) {
      setError('Cannot send empty message or invalid chat');
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
        contentType: 'text/plain',
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
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => ({
        ...prev,
        [selectedChat]: [...(prev[selectedChat] || []), tempMessage],
      }));

      const response = await axios.post(`${BASE_URL}/social/messages`, messageData, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const savedMessage = response.data.message;

      if (socket) {
        socket.emit('message', savedMessage, (ack) => {
          if (ack?.error) {
            console.error('Socket acknowledgment error:', ack.error);
            setError(`Failed to send message: ${ack.error}`);
            setMessages((prev) => {
              const chatMessages = prev[selectedChat] || [];
              return {
                ...prev,
                [selectedChat]: chatMessages.map((msg) =>
                  msg._id === clientMessageId ? { ...msg, status: 'failed' } : msg
                ),
              };
            });
            return;
          }

          setMessages((prev) => {
            const chatMessages = prev[selectedChat] || [];
            return {
              ...prev,
              [selectedChat]: chatMessages.map((msg) =>
                msg._id === clientMessageId
                  ? { ...savedMessage, content: plaintextContent, status: 'sent' }
                  : msg
              ),
            };
          });
        });
      }
      setMessage('');
      inputRef.current?.focus();
      listRef.current?.scrollToItem(messages[selectedChat]?.length || 0, 'end');
    } catch (err) {
      console.error('Send message error:', err);
      setError(`Failed to send message: ${err.message}`);
      setMessages((prev) => {
        const chatMessages = prev[selectedChat] || [];
        return {
          ...prev,
          [selectedChat]: chatMessages.map((msg) =>
            msg._id === clientMessageId ? { ...msg, status: 'failed' } : msg
          ),
        };
      });
    }
  }, [message, selectedChat, userId, token, virtualNumber, username, photo, socket]);

  const handleAddContact = async () => {
    if (!contactInput.trim()) {
      setContactError('Please enter a valid phone number');
      return;
    }
    try {
      const response = await axios.post(`${BASE_URL}/social/contacts`, {
        userId,
        phone: contactInput.trim(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setChatList([...chatList, response.data.user]);
      setContactInput('');
      setContactError('');
      setShowAddContact(false);
    } catch (err) {
      console.error('Add contact error:', err);
      setContactError(err.response?.data?.error || 'Failed to add contact');
    }
  };

  const handleLogout = useCallback(async () => {
    try {
      if (socket) {
        socket.emit('leave', userId);
        await axios.post(`${BASE_URL}/auth/logout`, {}, {
          headers: { Authorization: `Bearer ${token}` },
        });
        socket?.disconnect();
      }
      sessionStorage.clear();
      setAuth('', '', '', '', '', '');
      setChatList([]);
      setMessages({});
      setSelectedChatAndNotify(null);
      console.log('Logged out successfully');
      navigate('/');
    } catch (err) {
      console.error('Logout error:', err);
      setError('Failed to logout');
    }
  }, [socket, userId, setAuth, token, navigate]);

  useEffect(() => {
    const privateKey = sessionStorage.getItem('privateKey');
    if (!privateKey) {
      setError('Private key missing, please log in again');
      setTimeout(() => handleLogout(), 2000);
    } else {
      fetchChatList();
    }
  }, [fetchChatList, handleLogout]);

  useEffect(() => {
    if (selectedChat && !messages[selectedChat]) {
      setMessages((prev) => ({ ...prev, [selectedChat]: [] }));
      fetchMessages(selectedChat);
    }
  }, [selectedChat, fetchMessages]);

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

  useEffect(() => {
    if (!socket) return;

    socket.on('message', async (msg) => {
      const senderId = typeof msg.senderId === 'object' ? msg.senderId._id.toString() : msg.senderId;
      if (msg.recipientId === userId) {
        const privateKey = sessionStorage.getItem('privateKey');
        if (!privateKey) {
          setError('Private key missing, please log in again');
          return;
        }
        const decryptedContent = msg.contentType === 'text' ? await decryptMessage(msg.content, privateKey) : msg.content;
        setMessages((prev) => {
          const chatMessages = prev[senderId] || [];
          return {
            ...prev,
            [senderId]: [...chatMessages, { ...msg, content: decryptedContent }],
          };
        });
        if (selectedChat === senderId) {
          socket.emit('readMessages', { chatId: senderId, userId });
          setUnreadMessages((prev) => ({ ...prev, [senderId]: 0 }));
          listRef.current?.scrollToItem(messages[senderId]?.length || 0, 'end');
        } else {
          setUnreadMessages((prev) => ({ ...prev, [senderId]: (prev[senderId] || 0) + 1 }));
        }
      }
    });

    socket.on('typing', ({ userId: typingUserId, chatId }) => {
      if (chatId === selectedChat) {
        setIsTyping((prev) => ({ ...prev, [typingUserId]: true }));
        setTimeout(() => {
          setIsTyping((prev) => ({ ...prev, [typingUserId]: false }));
        }, 3000);
      }
    });

    socket.on('readMessages', ({ chatId }) => {
      if (chatId === selectedChat) {
        setMessages((prev) => {
          const chatMessages = prev[chatId] || [];
          return {
            ...prev,
            [chatId]: chatMessages.map((msg) => (msg.status === 'sent' ? { ...msg, status: 'read' } : msg)),
          };
        });
      }
    });

    return () => {
      socket.off('message');
      socket.off('typing');
      socket.off('readMessages');
    };
  }, [socket, selectedChat, userId, messages]);

  const handleTyping = useCallback(() => {
    if (socket && selectedChat) {
      socket.emit('typing', { chatId: selectedChat, userId });
    }
  }, [socket, selectedChat, userId]);

  const selectChat = (chatId) => {
    setSelectedChatAndNotify(chatId);
    setSelectedChat(chatId);
    setShowMenu(false);
    setError('');
    inputRef.current?.focus();
  };

  const renderMessage = ({ index, style }) => {
    const msg = messages[selectedChat][index];
    const prevMsg = index > 0 ? messages[selectedChat][index - 1] : null;
    const showDate = !prevMsg || new Date(msg.createdAt).toDateString() !== new Date(prevMsg.createdAt).toDateString();
    const isMine = msg.senderId === userId;

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
                  {msg.status === 'pending' ? '⌛' : ''}
                  {msg.status === 'sent' ? '✓' : ''}
                  {msg.status === 'read' ? '✓✓' : ''}
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
                  <FaPlus className="fa-plus menu-item-icon" />
                  Add Contact
                </div>
                <div className="menu-item logout" onClick={handleLogout}>
                  <FaSignOutAlt className="fa-sign-out menu-item-icon" />
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
                        placeholder="Enter phone number or email"
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