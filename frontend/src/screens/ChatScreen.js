import React, { useState, useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import forge from 'node-forge';
import { AutoSizer, List } from 'react-virtualized';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import {
  FaPaperPlane, FaPaperclip, FaArrowLeft, FaEllipsisH, FaFileAlt,
  FaPlay, FaUserPlus, FaSignOutAlt, FaCamera, FaVideo, FaMicrophone, FaTimes
} from 'react-icons/fa';
import './ChatScreen.css';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const ChatScreen = React.memo(({ token, userId, setAuth, socket, username, virtualNumber, photo, setSelectedChat }) => {
  const [chatList, setChatList] = useState([]);
  const [messages, setMessages] = useState({});
  const [selectedChat, setSelectedChatState] = useState(null);
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState([]);
  const [captions, setCaptions] = useState({});
  const [contentType, setContentType] = useState('text');
  const [showMenu, setShowMenu] = useState(false);
  const [menuTab, setMenuTab] = useState('');
  const [newContactNumber, setNewContactNumber] = useState('');
  const [error, setError] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [typingUsers, setTypingUsers] = useState({});
  const chatRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const typingTimeoutRef = useRef({});

  const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

  const setSelectedChatAndNotify = (chatId) => {
    setSelectedChatState(chatId);
    setSelectedChat(chatId);
    if (chatId && messages[chatId]?.length) {
      updateMessageStatuses(chatId);
    }
  };

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
    try {
      const { data } = await axios.get(`${BASE_URL}/auth/public_key/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return data.publicKey;
    } catch (err) {
      console.error(`Failed to fetch public key for ${recipientId}:`, err);
      throw err;
    }
  }, [token]);

  const handleLogout = useCallback(async () => {
    try {
      socket.emit('leave', userId);
      localStorage.clear();
      setAuth('', '', '', '', '', '');
      setChatList([]);
      setMessages({});
      setSelectedChatAndNotify(null);
      console.log('Logged out successfully');
    } catch (err) {
      console.error('Logout error:', err);
      setError('Failed to logout');
    }
  }, [socket, userId, setAuth]);

  const compressImage = async (file) => {
    try {
      return new Promise((resolve) => {
        const img = new Image();
        const reader = new FileReader();
        reader.onload = (e) => {
          img.src = e.target.result;
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const maxWidth = 800;
            const maxHeight = 800;
            let width = img.width;
            let height = img.height;

            if (width > height) {
              if (width > maxWidth) {
                height *= maxWidth / width;
                width = maxWidth;
              }
            } else {
              if (height > maxHeight) {
                width *= maxHeight / height;
                height = maxHeight;
              }
            }

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            canvas.toBlob(
              (blob) => resolve(new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() })),
              'image/jpeg',
              0.7
            );
          };
        };
        reader.readAsDataURL(file);
      });
    } catch (err) {
      console.error('Image compression error:', err);
      throw err;
    }
  };

  const formatChatListDate = (date) => format(parseISO(date), 'hh:mm a');
  const formatDateHeader = (date) => {
    const parsed = parseISO(date);
    if (isToday(parsed)) return 'Today';
    if (isYesterday(parsed)) return 'Yesterday';
    return format(parsed, 'MMM d, yyyy');
  };
  const formatTime = (date) => format(parseISO(date), 'hh:mm a');

  const updateMessageStatuses = useCallback(async (recipientId) => {
    try {
      const unreadMessages = messages[recipientId]?.filter(
        (msg) => msg.recipientId === userId && msg.status !== 'read' && isValidObjectId(msg._id)
      );
      if (!unreadMessages?.length) return;

      const messageIds = unreadMessages.map((msg) => msg._id);
      socket.emit('batchMessageStatus', { messageIds, status: 'read', recipientId: userId });

      setMessages((prev) => ({
        ...prev,
        [recipientId]: prev[recipientId].map((msg) =>
          messageIds.includes(msg._id) ? { ...msg, status: 'read' } : msg
        ),
      }));
    } catch (err) {
      console.error('Update message statuses failed:', err);
    }
  }, [messages, userId, socket]);

  const fetchChatList = useCallback(async () => {
    try {
      const { data } = await axios.get(`${BASE_URL}/social/chat-list`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId },
        timeout: 10000,
      });
      const privateKeyPem = localStorage.getItem('privateKey');
      const processedUsers = await Promise.all(
        data.map(async (user) => {
          if (user.latestMessage) {
            user.latestMessage.content =
              user.latestMessage.senderId === userId
                ? `You: ${user.latestMessage.plaintextContent || '[Media]'}` 
                : user.latestMessage.recipientId === userId && user.latestMessage.contentType === 'text'
                ? await decryptMessage(user.latestMessage.content, privateKeyPem)
                : `[${user.latestMessage.contentType}]`;
          }
          return user;
        })
      );
      setChatList(processedUsers);
      setError('');
      socket.emit('chatListUpdated', { userId, users: processedUsers });
    } catch (err) {
      console.error('Fetch chat list failed:', err);
      if (err.response?.status === 401) {
        setError('Session expired, please log in again');
        setTimeout(() => handleLogout(), 2000);
      } else {
        setError('Failed to load chat list');
      }
    }
  }, [token, userId, handleLogout, decryptMessage, socket]);

  const fetchMessages = useCallback(async (recipientId) => {
    if (!recipientId || !isValidObjectId(recipientId)) {
      setError('Invalid chat selected');
      return;
    }
    try {
      const { data } = await axios.get(`${BASE_URL}/social/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, recipientId, limit: 50, skip: 0 },
        timeout: 10000,
      });
      const privateKeyPem = localStorage.getItem('privateKey');
      const decryptedMessages = await Promise.all(
        data.messages.map(async (msg) => {
          const newMsg = { ...msg };
          if (msg.senderId === userId) {
            newMsg.content = msg.plaintextContent || msg.content;
          } else if (msg.recipientId === userId) {
            newMsg.content =
              msg.contentType === 'text' ? await decryptMessage(msg.content, privateKeyPem) : msg.content;
          }
          return newMsg;
        })
      );
      setMessages((prev) => ({
        ...prev,
        [recipientId]: decryptedMessages.reverse(),
      }));
      listRef.current?.scrollToRow(decryptedMessages.length - 1);
      updateMessageStatuses(recipientId);
      setError('');
    } catch (err) {
      console.error('Fetch messages failed:', err);
      if (err.response?.status === 401) {
        setError('Session expired, please log in again');
        setTimeout(() => handleLogout(), 2000);
      } else {
        setError('Failed to load messages');
        setMessages((prev) => ({ ...prev, [recipientId]: [] }));
      }
    }
  }, [token, userId, decryptMessage, handleLogout, updateMessageStatuses]);

  const handleFileChange = useCallback(async (e, type) => {
    try {
      const selectedFiles = Array.from(e.target.files);
      if (!selectedFiles.length || !selectedChat) {
        setError('No files selected or no chat selected');
        return;
      }
      const compressedFiles = await Promise.all(
        selectedFiles.map((file) => (file.type.startsWith('image') ? compressImage(file) : file))
      );
      setFiles(compressedFiles);
      setContentType(type);

      for (const file of compressedFiles) {
        const clientMessageId = generateClientMessageId();
        const tempMessage = {
          _id: clientMessageId,
          senderId: userId,
          recipientId: selectedChat,
          content: URL.createObjectURL(file),
          contentType: type,
          status: 'uploading',
          createdAt: new Date().toISOString(),
          originalFilename: file.name,
          senderVirtualNumber: virtualNumber,
          senderUsername: username,
          senderPhoto: photo,
        };

        setMessages((prev) => ({
          ...prev,
          [selectedChat]: [...(prev[selectedChat] || []), tempMessage],
        }));

        const formData = new FormData();
        formData.append('file', file);
        formData.append('userId', userId);
        formData.append('recipientId', selectedChat);
        formData.append('clientMessageId', clientMessageId);
        formData.append('senderVirtualNumber', virtualNumber);
        formData.append('senderUsername', username);
        formData.append('senderPhoto', photo);
        if (captions[file.name]) {
          formData.append('caption', captions[file.name]);
        }

        try {
          const response = await axios.post(`${BASE_URL}/social/upload`, formData, {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'multipart/form-data',
            },
          });

          const { message: uploadedMessage } = response.data;
          setMessages((prev) => {
            const chatMessages = prev[selectedChat] || [];
            return {
              ...prev,
              [selectedChat]: chatMessages.map((msg) =>
                msg._id === clientMessageId ? { ...uploadedMessage, status: 'sent' } : msg
              ),
            };
          });
          socket.emit('message', uploadedMessage);
        } catch (error) {
          console.error('Media upload failed:', error);
          setMessages((prev) => {
            const chatMessages = prev[selectedChat] || [];
            return {
              ...prev,
              [selectedChat]: chatMessages.map((msg) =>
                msg._id === clientMessageId ? { ...msg, status: 'failed' } : msg
              ),
            };
          });
          setError('Failed to upload media');
        }
      }

      setFiles([]);
      setCaptions({});
      setMessage('');
      inputRef.current?.focus();
    } catch (err) {
      console.error('File change error:', err);
      setError('Error processing file');
    }
  }, [selectedChat, userId, token, socket, virtualNumber, username, photo, captions]);

  const handleAddContact = useCallback(async () => {
    if (!newContactNumber.trim()) {
      setError('Please enter a virtual number');
      return;
    }
    try {
      const { data } = await axios.post(
        `${BASE_URL}/social/add_contact`,
        { userId, virtualNumber: newContactNumber.trim() },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
      if (!data?.id || !isValidObjectId(data.id)) {
        throw new Error('Invalid contact data');
      }
      setChatList((prev) => {
        if (prev.some((u) => u.id === data.id)) {
          setError('Contact already exists');
          return prev;
        }
        return [...prev, data];
      });
      socket.emit('newContact', { userId, contactData: data });
      setNewContactNumber('');
      setMenuTab('');
      setShowMenu(false);
      setError('');
    } catch (err) {
      console.error('Add contact error:', err);
      if (err.response?.status === 400) {
        setError('Contact does not exist or already added');
      } else if (err.response?.status === 401) {
        setError('Session expired, please log in again');
        setTimeout(() => handleLogout(), 1000);
      } else {
        setError('Failed to add contact');
      }
    }
  }, [newContactNumber, userId, token, socket, handleLogout]);

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
        contentType: 'text',
        plaintextContent,
        clientMessageId,
        senderVirtualNumber: virtualNumber,
        senderUsername: username,
        senderPhoto: photo,
      };
      const tempMessage = {
        _id: clientMessageId,
        senderId: userId,
        recipientId: selectedChat,
        content: plaintextContent,
        contentType: 'text',
        status: 'pending',
        createdAt: new Date().toISOString(),
        clientMessageId,
        senderVirtualNumber: virtualNumber,
        senderUsername: username,
        senderPhoto: photo,
      };
      setMessages((prev) => ({
        ...prev,
        [selectedChat]: [...(prev[selectedChat] || []), tempMessage],
      }));
      socket.emit('message', messageData, (ack) => {
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
        const { message: sentMessage } = ack;
        setMessages((prev) => {
          const chatMessages = prev[selectedChat] || [];
          return {
            ...prev,
            [selectedChat]: chatMessages.map((msg) =>
              msg._id === clientMessageId
                ? { ...sentMessage, content: plaintextContent, status: 'sent' }
                : msg
            ),
          };
        });
      });
      setMessage('');
      inputRef.current?.focus();
      listRef.current?.scrollToRow(messages[selectedChat]?.length || 0);
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
  }, [message, selectedChat, userId, socket, encryptMessage, getPublicKey, virtualNumber, username, photo, messages]);

  const handleTyping = useCallback(() => {
    if (!selectedChat) return;
    socket.emit('typing', { userId, recipientId: selectedChat });
    clearTimeout(typingTimeoutRef.current[selectedChat]);
    typingTimeoutRef.current[selectedChat] = setTimeout(() => {
      socket.emit('stopTyping', { userId, recipientId: selectedChat });
    }, 2000);
  }, [socket, selectedChat, userId]);

  useEffect(() => {
    fetchChatList();
  }, [fetchChatList]);

  useEffect(() => {
    if (selectedChat && !messages[selectedChat] && isValidObjectId(selectedChat)) {
      setMessages((prev) => ({ ...prev, [selectedChat]: [] }));
      fetchMessages(selectedChat);
    }
  }, [selectedChat, fetchMessages]);

  useEffect(() => {
    if (!socket || !userId) return;
    socket.on('connect', () => {
      console.log('Socket connected:', socket.id);
      socket.emit('join', userId);
    });
    socket.on('disconnect', (reason) => {
      console.warn('Socket disconnected:', reason);
      if (reason === 'io server disconnect') {
        socket.connect();
      }
    });
    socket.on('message', async (msg) => {
      try {
        const senderId = typeof msg.senderId === 'object' ? msg.senderId._id.toString() : msg.senderId;
        const recipientId = typeof msg.recipientId === 'object' ? msg.recipientId._id.toString() : msg.recipientId;
        if (!isValidObjectId(senderId) || !isValidObjectId(recipientId)) {
          console.warn('Invalid message IDs:', { senderId, recipientId });
          return;
        }
        const chatRecipientId = senderId === userId ? recipientId : senderId;
        const privateKeyPem = localStorage.getItem('privateKey') || '';
        let decryptedContent = msg.content;
        if (msg.contentType === 'text' && recipientId === userId && privateKeyPem) {
          decryptedContent = await decryptMessage(msg.content, privateKeyPem);
        }
        const newMessage = { ...msg, content: decryptedContent, senderId, recipientId, status: recipientId === userId ? 'delivered' : msg.status };
        setMessages((prev) => ({
          ...prev,
          [chatRecipientId]: [...(prev[chatRecipientId] || []), newMessage],
        }));
        if (recipientId === userId && selectedChat === senderId) {
          socket.emit('messageStatus', { messageId: msg._id, status: 'delivered' });
          listRef.current?.scrollToRow(messages[chatRecipientId]?.length || 0);
        }
      } catch (err) {
        console.error('Handle message error:', err);
        setError('Failed to process message');
      }
    });
    socket.on('chatListUpdated', ({ users }) => {
      if (Array.isArray(users)) {
        setChatList(users);
      }
    });
    socket.on('newContact', ({ contactData }) => {
      if (contactData?.id && isValidObjectId(contactData.id)) {
        setChatList((prev) => {
          if (prev.some((u) => u.id === contactData.id)) return prev;
          return [...prev, contactData];
        });
      }
    });
    socket.on('typing', ({ userId: typingUserId }) => {
      if (selectedChat === typingUserId) {
        setTypingUsers((prev) => ({ ...prev, [typingUserId]: true }));
      }
    });
    socket.on('stopTyping', ({ userId: typingUserId }) => {
      setTypingUsers((prev) => ({ ...prev, [typingUserId]: false }));
    });
    socket.on('messageStatus', ({ messageId, status }) => {
      setMessages((prev) => {
        const updatedMessages = Object.keys(prev).reduce((acc, chatId) => {
          acc[chatId] = prev[chatId].map((msg) =>
            msg._id === messageId ? { ...msg, status } : msg
          );
          return acc;
        }, {});
        return updatedMessages;
      });
    });
    socket.on('batchMessageStatus', ({ messageIds, status }) => {
      setMessages((prev) => {
        const updatedMessages = Object.keys(prev).reduce((acc, chatId) => {
          acc[chatId] = prev[chatId].map((msg) =>
            messageIds.includes(msg._id) ? { ...msg, status } : msg
          );
          return acc;
        }, {});
        return updatedMessages;
      });
    });
    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('message');
      socket.off('chatListUpdated');
      socket.off('newContact');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
      socket.off('batchMessageStatus');
    };
  }, [socket, userId, selectedChat, decryptMessage, messages]);

  const getRowHeight = useCallback(({ index }) => {
    const chatMessages = messages[selectedChat] || [];
    const msg = chatMessages[index];
    if (!msg) return 100;
    const baseHeight = 60;
    const contentHeight = msg.contentType === 'text' ? Math.min((msg.content?.length || 0) / 50, 4) * 20 : 200;
    return baseHeight + contentHeight;
  }, [messages, selectedChat]);

  const renderMessage = useCallback(({ index, key, style }) => {
    const chatMessages = messages[selectedChat] || [];
    if (!chatMessages[index]) return <div key={key} style={style} />;
    const msg = chatMessages[index];
    const prevMsg = index > 0 ? chatMessages[index - 1] : null;
    const isMine = msg.senderId === userId;
    const showDate = !prevMsg || formatDateHeader(prevMsg.createdAt) !== formatDateHeader(msg.createdAt);

    return (
      <div key={msg._id || msg.clientMessageId} style={style} className="message-container">
        {showDate && (
          <div className="date-header">
            <span>{formatDateHeader(msg.createdAt)}</span>
          </div>
        )}
        <div className={`message ${isMine ? 'mine' : 'other'}`}>
          {msg.contentType === 'text' && <p className="message-content">{msg.content || '[Empty message]'}</p>}
          {msg.contentType === 'image' && (
            <img src={msg.content} alt="Sent image" className="message-media" onError={() => console.error(`Failed to load image: ${msg.content}`)} />
          )}
          {msg.contentType === 'video' && (
            <video controls className="message-media">
              <source src={msg.content} type="video/mp4" />
            </video>
          )}
          {msg.contentType === 'audio' && (
            <audio controls className="message-audio">
              <source src={msg.content} type="audio/mpeg" />
            </audio>
          )}
          {msg.contentType === 'document' && (
            <a href={msg.content} target="_blank" rel="noopener noreferrer" className="message-document">
              <FaFileAlt className="mr-2" /> {msg.originalFilename || 'Document'}
            </a>
          )}
          {msg.caption && <p className="message-caption">{msg.caption}</p>}
          <div className="message-meta">
            <span>{formatTime(msg.createdAt)}</span>
            {isMine && (
              <span className="message-status">
                {msg.status === 'pending' ? 'Sending...' :
                 msg.status === 'sent' ? '✓' :
                 msg.status === 'delivered' ? '✓✓' :
                 msg.status === 'read' ? <span style={{ color: '#34C759' }}>✓✓</span> :
                 'Failed'}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }, [selectedChat, messages, userId]);

  const chatListRowRenderer = useCallback(({ index, key, style }) => {
    const user = chatList[index];
    if (!user || !user.id || !isValidObjectId(user.id)) {
      return <div key={key} style={style} />;
    }
    return (
      <div
        key={user.id}
        style={style}
        className={`chat-list-item ${selectedChat === user.id ? 'selected' : ''}`}
        onClick={() => setSelectedChatAndNotify(user.id)}
      >
        <img src={user.photo} alt={user.username} className="chat-list-avatar" />
        <div className="chat-list-info">
          <div className="chat-list-header">
            <span className="chat-list-username">{user.username}</span>
            {user.latestMessage && (
              <span className="chat-list-time">{formatChatListDate(user.latestMessage.createdAt)}</span>
            )}
          </div>
          <div className="chat-list-preview">
            {user.latestMessage?.content || 'No messages'}
            {user.unreadCount > 0 && (
              <span className="unread-badge">{user.unreadCount}</span>
            )}
          </div>
        </div>
      </div>
    );
  }, [chatList, selectedChat, setSelectedChatAndNotify]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showMenu && !event.target.closest('.chat-menu') && !event.target.closest('.menu-dropdown')) {
        setShowMenu(false);
        setMenuTab('');
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showMenu]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (error && !event.target.closest('.error-message')) {
        setError('');
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [error]);

  return (
    <div className="chat-screen">
      <div className="chat-header">
        <h1>Chat</h1>
        <div className="chat-menu">
          <FaEllipsisH onClick={() => setShowMenu(!showMenu)} />
          <AnimatePresence>
            {showMenu && (
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.8 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                className="menu-dropdown"
              >
                <div
                  className="menu-item"
                  onClick={() => setMenuTab(menuTab === 'add' ? '' : 'add')}
                >
                  <FaUserPlus className="menu-item-icon" /> Add Contact
                </div>
                <div className="menu-item logout" onClick={handleLogout}>
                  <FaSignOutAlt className="menu-item-icon" /> Logout
                </div>
                {menuTab === 'add' && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="menu-add-contact"
                  >
                    <div className="contact-input-group">
                      <input
                        type="text"
                        value={newContactNumber}
                        onChange={(e) => setNewContactNumber(e.target.value)}
                        placeholder="Enter virtual number"
                        className={`contact-input ${error ? 'error' : ''}`}
                      />
                      {newContactNumber && (
                        <FaTimes
                          className="clear-input-icon"
                          onClick={() => setNewContactNumber('')}
                        />
                      )}
                    </div>
                    <button onClick={handleAddContact} className="contact-button">
                      Add Contact
                    </button>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      {error && <div className="error-message">{error}</div>}
      <div className="chat-content">
        {!selectedChat ? (
          <div className="chat-list">
            <AutoSizer>
              {({ width, height }) => (
                <List
                  width={width}
                  height={height}
                  rowCount={chatList.length}
                  rowHeight={70}
                  rowRenderer={chatListRowRenderer}
                />
              )}
            </AutoSizer>
          </div>
        ) : (
          <div className="chat-conversation">
            <div className="conversation-header">
              <FaArrowLeft
                className="back-icon"
                onClick={() => setSelectedChatAndNotify(null)}
              />
              <img
                src={chatList.find((u) => u.id === selectedChat)?.photo || 'default-avatar.png'}
                alt="User"
                className="conversation-avatar"
              />
              <div className="conversation-info">
                <h2>{chatList.find((u) => u.id === selectedChat)?.username || 'Unknown'}</h2>
                {typingUsers[selectedChat] && (
                  <span className="typing-indicator">Typing...</span>
                )}
              </div>
            </div>
            <div className="conversation-messages" ref={chatRef}>
              {messages[selectedChat] === undefined ? (
                <div className="loading-messages">Loading messages...</div>
              ) : messages[selectedChat]?.length === 0 ? (
                <div className="no-messages">No messages yet. Start chatting!</div>
              ) : (
                <AutoSizer>
                  {({ width, height }) => (
                    <List
                      ref={listRef}
                      width={width}
                      height={height}
                      rowCount={messages[selectedChat]?.length || 0}
                      rowHeight={getRowHeight}
                      rowRenderer={renderMessage}
                    />
                  )}
                </AutoSizer>
              )}
            </div>
            <div className="input-bar">
              <FaPaperclip
                className="attachment-icon"
                onClick={() => setShowPicker(!showPicker)}
              />
              {showPicker && (
                <div className="attachment-picker">
                  <label className="picker-item">
                    <FaCamera />
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleFileChange(e, 'image')}
                      hidden
                    />
                  </label>
                  <label className="picker-item">
                    <FaVideo />
                    <input
                      type="file"
                      accept="video/*"
                      onChange={(e) => handleFileChange(e, 'video')}
                      hidden
                    />
                  </label>
                  <label className="picker-item">
                    <FaMicrophone />
                    <input
                      type="file"
                      accept="audio/*"
                      onChange={(e) => handleFileChange(e, 'audio')}
                      hidden
                    />
                  </label>
                  <label className="picker-item">
                    <FaFileAlt />
                    <input
                      type="file"
                      onChange={(e) => handleFileChange(e, 'document')}
                      hidden
                    />
                  </label>
                </div>
              )}
              <input
                ref={inputRef}
                type="text"
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  handleTyping();
                }}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Type a message..."
                className="message-input"
                disabled={!selectedChat}
              />
              <FaPaperPlane
                className="send-icon"
                onClick={sendMessage}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default ChatScreen;