import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import forge from 'node-forge';
import { List } from 'react-virtualized';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import {
  FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply, FaEllipsisH, FaFileAlt,
  FaPlay, FaArrowDown, FaUserPlus, FaSignOutAlt, FaUser, FaCamera, FaVideo, FaMicrophone
} from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import { setMessages, addMessage, updateMessageStatus, setSelectedChat, resetState, replaceMessage } from '../store';
import { saveMessages, getMessages, clearOldMessages, savePendingMessages, loadPendingMessages } from '../db';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const ChatScreen = React.memo(({ token, userId, setAuth, socket, username, virtualNumber, photo }) => {
  const dispatch = useDispatch();
  const { chats, selectedChat } = useSelector((state) => state.messages);
  const [users, setUsers] = useState(() => JSON.parse(localStorage.getItem('cachedUsers')) || []);
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState([]);
  const [captions, setCaptions] = useState({});
  const [contentType, setContentType] = useState('text');
  const [isTyping, setIsTyping] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [menuTab, setMenuTab] = useState('');
  const [newContactNumber, setNewContactNumber] = useState('');
  const [error, setError] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [mediaPreview, setMediaPreview] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [pendingMessages, setPendingMessages] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({});
  const chatRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isAtBottomRef = useRef(true);

  const handleLogout = useCallback(() => {
    socket.emit('leave', userId);
    dispatch(resetState());
    localStorage.clear();
    setUsers([]);
    setAuth('', '', '', '', '');
  }, [dispatch, setAuth, userId, socket]);

  const encryptMessage = useCallback(async (content, recipientPublicKey, isMedia = false) => {
    const aesKey = forge.random.getBytesSync(32);
    const iv = forge.random.getBytesSync(16);
    const cipher = forge.cipher.createCipher('AES-CBC', aesKey);
    cipher.start({ iv });
    cipher.update(forge.util.createBuffer(isMedia ? content : forge.util.encodeUtf8(content)));
    cipher.finish();
    return `${forge.util.encode64(cipher.output.getBytes())}|${forge.util.encode64(iv)}|${forge.util.encode64(
      forge.pki.publicKeyFromPem(recipientPublicKey).encrypt(aesKey, 'RSA-OAEP', { md: forge.md.sha256.create() })
    )}`;
  }, []);

  const decryptMessage = useCallback(async (encryptedContent, privateKeyPem, isMedia = false) => {
    try {
      const [encryptedData, iv, encryptedAesKey] = encryptedContent.split('|').map(forge.util.decode64);
      const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
      const aesKey = privateKey.decrypt(encryptedAesKey, 'RSA-OAEP', { md: forge.md.sha256.create() });
      const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
      decipher.start({ iv });
      decipher.update(forge.util.createBuffer(encryptedData));
      decipher.finish();
      return isMedia ? decipher.output.getBytes() : forge.util.decodeUtf8(decipher.output.getBytes());
    } catch (err) {
      console.error('Decryption error:', err);
      return '[Decryption Failed]';
    }
  }, []);

  const getPublicKey = useCallback(async (recipientId) => {
    const cacheKey = `publicKey:${recipientId}`;
    const cachedKey = localStorage.getItem(cacheKey);
    if (cachedKey) return cachedKey;
    const { data } = await axios.get(`${BASE_URL}/auth/public_key/${recipientId}`, { headers: { Authorization: `Bearer ${token}` } });
    localStorage.setItem(cacheKey, data.publicKey);
    return data.publicKey;
  }, [token]);

  const compressImage = async (file) => {
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
          canvas.toBlob((blob) => resolve(new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() })), 'image/jpeg', 0.7);
        };
      };
      reader.readAsDataURL(file);
    });
  };

  const formatChatListDate = (date) => format(parseISO(date), 'hh:mm a');
  const formatDateHeader = (date) => {
    const parsed = parseISO(date);
    if (isToday(parsed)) return 'Today';
    if (isYesterday(parsed)) return 'Yesterday';
    return format(parsed, 'MMM d, yyyy');
  };
  const formatTime = (date) => format(parseISO(date), 'hh:mm a');

  const fetchChatList = useCallback(async () => {
    const cached = localStorage.getItem('cachedUsers');
    if (cached) return; // Skip fetch if cached
    try {
      const { data } = await axios.get(`${BASE_URL}/social/chat-list`, { headers: { Authorization: `Bearer ${token}` }, params: { userId } });
      const privateKeyPem = localStorage.getItem('privateKey');
      const processedUsers = await Promise.all(data.map(async (user) => {
        if (user.latestMessage) {
          user.latestMessage.content = user.latestMessage.senderId === userId
            ? `You: ${user.latestMessage.plaintextContent || '[Media]'}`
            : user.latestMessage.recipientId === userId && user.latestMessage.contentType === 'text'
            ? await decryptMessage(user.latestMessage.content, privateKeyPem)
            : `[${user.latestMessage.contentType}]`;
        }
        return user;
      }));
      setUsers(processedUsers);
      localStorage.setItem('cachedUsers', JSON.stringify(processedUsers));
    } catch (err) {
      setError(`Failed to load chat list: ${err.message}`);
      if (err.response?.status === 401) handleLogout();
    }
  }, [token, userId, handleLogout, decryptMessage]);

  const fetchMessages = useCallback(async (recipientId) => {
    const localMessages = await getMessages(recipientId);
    if (localMessages.length) {
      dispatch(setMessages({ recipientId, messages: localMessages }));
      listRef.current?.scrollToRow(localMessages.length - 1);
    } else {
      try {
        const { data } = await axios.get(`${BASE_URL}/social/messages`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId, limit: 50, skip: 0 },
        });
        const privateKeyPem = localStorage.getItem('privateKey');
        const messages = await Promise.all(data.messages.map(async (msg) => {
          const newMsg = { ...msg };
          if (msg.senderId === userId) {
            newMsg.content = msg.plaintextContent || msg.content;
          } else if (msg.recipientId === userId) {
            newMsg.content = msg.contentType === 'text'
              ? await decryptMessage(msg.content, privateKeyPem)
              : msg.content;
          }
          return newMsg;
        }));
        dispatch(setMessages({ recipientId, messages }));
        await saveMessages(messages);
        listRef.current?.scrollToRow(messages.length - 1);
      } catch (err) {
        setError(`Failed to load messages: ${err.message}`);
      }
    }
  }, [token, userId, dispatch, decryptMessage]);

  const sendPendingMessages = useCallback(async () => {
    if (!navigator.onLine || !pendingMessages.length) return;
    for (const { tempId, recipientId, messageData } of pendingMessages) {
      try {
        const response = await axios.post(`${BASE_URL}/social/message`, messageData, { headers: { Authorization: `Bearer ${token}` } });
        const { data } = response;
        dispatch(replaceMessage({ recipientId, message: { ...data, content: data.plaintextContent || data.content }, replaceId: tempId }));
        await saveMessages([{ ...data, content: data.plaintextContent || data.content }]);
        setPendingMessages((prev) => prev.filter((p) => p.tempId !== tempId));
        await savePendingMessages(pendingMessages.filter((p) => p.tempId !== tempId));
      } catch (err) {
        console.error('Pending message send error:', err);
      }
    }
  }, [pendingMessages, token, dispatch]);

  const handleFileChange = async (e, type) => {
    const selectedFiles = Array.from(e.target.files);
    if (!selectedFiles.length) return;

    const compressedFiles = await Promise.all(selectedFiles.map(file => file.type.startsWith('image') ? compressImage(file) : file));
    setFiles(compressedFiles);
    setContentType(type);
    setMediaPreview(compressedFiles.map(file => ({ type, url: URL.createObjectURL(file), originalFile: file })));
    setShowPicker(false);

    const tempMessages = compressedFiles.map(file => {
      const clientMessageId = `${userId}-${Date.now()}-${Math.random().toString(36).substring(2)}`;
      return {
        _id: clientMessageId,
        senderId: userId,
        recipientId: selectedChat,
        contentType: type,
        content: URL.createObjectURL(file),
        status: 'uploading',
        createdAt: new Date().toISOString(),
        originalFilename: file.name,
        uploadProgress: 0,
        clientMessageId,
        senderVirtualNumber: virtualNumber,
        senderUsername: username,
        senderPhoto: photo,
      };
    });

    tempMessages.forEach(msg => dispatch(addMessage({ recipientId: selectedChat, message: msg })));
    if (isAtBottomRef.current) listRef.current?.scrollToRow((chats[selectedChat] || []).length - 1);

    for (const [index, file] of compressedFiles.entries()) {
      const clientMessageId = tempMessages[index]._id;
      const formData = new FormData();
      formData.append('file', file);
      formData.append('userId', userId);
      formData.append('recipientId', selectedChat);
      formData.append('clientMessageId', clientMessageId);
      formData.append('senderVirtualNumber', virtualNumber);
      formData.append('senderUsername', username);
      formData.append('senderPhoto', photo);

      try {
        const response = await axios.post(
          `${BASE_URL}/social/upload`,
          formData,
          {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
            onUploadProgress: (progressEvent) => {
              const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              setUploadProgress((prev) => ({ ...prev, [clientMessageId]: percentCompleted }));
              dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'uploading', uploadProgress: percentCompleted }));
            },
          }
        );

        const { message: uploadedMessage } = response.data;
        dispatch(replaceMessage({ recipientId: selectedChat, message: uploadedMessage, replaceId: clientMessageId }));
        socket.emit('message', uploadedMessage);
        await saveMessages([uploadedMessage]);
      } catch (error) {
        console.error('Media upload failed:', error);
        dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: clientMessageId, status: 'failed' }));
      } finally {
        setUploadProgress((prev) => {
          const newProgress = { ...prev };
          delete newProgress[clientMessageId];
          return newProgress;
        });
      }
    }

    setFiles([]);
    setMediaPreview([]);
  };

  const handleAddContact = async () => {
    if (!newContactNumber) {
      setError('Please enter a virtual number');
      return;
    }
    try {
      const { data } = await axios.post(
        `${BASE_URL}/auth/add_contact`,
        { userId, virtualNumber: newContactNumber },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setUsers((prev) => [...prev, data]);
      localStorage.setItem('cachedUsers', JSON.stringify([...users, data]));
      socket.emit('newContact', { userId, contactData: data });
      setNewContactNumber('');
      setMenuTab('');
      setShowMenu(false);
      setError('');
    } catch (err) {
      setError(`Failed to add contact: ${err.response?.data?.error || err.message}`);
    }
  };

  const sendMessage = useCallback(async () => {
    if ((!message.trim() && !files.length) || !selectedChat) return;
    const recipientId = selectedChat;
    const clientMessageId = `${userId}-${Date.now()}-${Math.random().toString(36).substring(2)}`;
    const plaintextContent = message.trim();

    try {
      const recipientPublicKey = await getPublicKey(recipientId);
      const encryptedContent = await encryptMessage(plaintextContent, recipientPublicKey);

      const tempMessage = {
        _id: clientMessageId,
        senderId: userId,
        recipientId,
        content: plaintextContent,
        contentType: 'text',
        plaintextContent,
        status: 'pending',
        createdAt: new Date().toISOString(),
        clientMessageId,
        senderVirtualNumber: virtualNumber,
        senderUsername: username,
        senderPhoto: photo,
        replyTo: replyTo ? { ...replyTo, content: replyTo.content } : undefined,
      };

      dispatch(addMessage({ recipientId, message: tempMessage }));
      await saveMessages([tempMessage]);
      if (isAtBottomRef.current) listRef.current?.scrollToRow((chats[recipientId] || []).length - 1);

      const messageData = {
        senderId: userId,
        recipientId,
        content: encryptedContent,
        contentType: 'text',
        plaintextContent,
        clientMessageId,
        senderVirtualNumber: virtualNumber,
        senderUsername: username,
        senderPhoto: photo,
        replyTo: replyTo ? replyTo._id : undefined,
      };

      if (!navigator.onLine) {
        setPendingMessages((prev) => [...prev, { tempId: clientMessageId, recipientId, messageData }]);
        await savePendingMessages([...pendingMessages, { tempId: clientMessageId, recipientId, messageData }]);
      } else {
        const response = await axios.post(`${BASE_URL}/social/message`, messageData, { headers: { Authorization: `Bearer ${token}` } });
        const { message: sentMessage } = response.data;
        dispatch(replaceMessage({ recipientId, message: { ...sentMessage, content: plaintextContent }, replaceId: clientMessageId }));
        socket.emit('message', sentMessage);
        await saveMessages([{ ...sentMessage, content: plaintextContent }]);
      }

      setMessage('');
      setReplyTo(null);
      socket.emit('stopTyping', { userId, recipientId });
    } catch (err) {
      console.error('Send message error:', err);
      setPendingMessages((prev) => [...prev, { tempId: clientMessageId, recipientId, messageData }]);
      await savePendingMessages([...pendingMessages, { tempId: clientMessageId, recipientId, messageData }]);
      setError('Failed to send message');
    }
  }, [message, selectedChat, userId, token, socket, dispatch, encryptMessage, getPublicKey, virtualNumber, username, photo, replyTo, files, pendingMessages]);

  const handleTyping = useCallback(() => {
    if (!selectedChat || !message.trim()) return;
    socket.emit('typing', { userId, recipientId: selectedChat });
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => socket.emit('stopTyping', { userId, recipientId: selectedChat }), 2000);
  }, [message, selectedChat, userId, socket]);

  const handleScroll = ({ scrollTop, scrollHeight, clientHeight }) => {
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10;
    isAtBottomRef.current = isAtBottom;
    setShowJumpToBottom(!isAtBottom && (chats[selectedChat] || []).length > 20);
  };

  const jumpToBottom = () => {
    listRef.current?.scrollToRow((chats[selectedChat] || []).length - 1);
    setShowJumpToBottom(false);
  };

  useEffect(() => {
    fetchChatList();
    const pending = loadPendingMessages();
    setPendingMessages(pending);
    const interval = setInterval(sendPendingMessages, 5000);
    return () => clearInterval(interval);
  }, [fetchChatList, sendPendingMessages]);

  useEffect(() => {
    if (selectedChat) fetchMessages(selectedChat);
  }, [selectedChat, fetchMessages]);

  useEffect(() => {
    socket.on('message', async (msg) => {
      const privateKeyPem = localStorage.getItem('privateKey');
      const decryptedContent = msg.contentType === 'text' && msg.recipientId === userId
        ? await decryptMessage(msg.content, privateKeyPem)
        : msg.content;
      const newMessage = { ...msg, content: decryptedContent };
      dispatch(addMessage({ recipientId: msg.senderId === userId ? msg.recipientId : msg.senderId, message: newMessage }));
      await saveMessages([newMessage]);
      if (msg.recipientId === userId && selectedChat === msg.senderId && isAtBottomRef.current) {
        listRef.current?.scrollToRow((chats[msg.senderId] || []).length - 1);
        socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: msg.senderId });
      }
    });

    socket.on('typing', ({ userId: typerId }) => setIsTyping((prev) => ({ ...prev, [typerId]: true })));
    socket.on('stopTyping', ({ userId: typerId }) => setIsTyping((prev) => ({ ...prev, [typerId]: false })));
    socket.on('messageStatus', ({ messageId, status }) => dispatch(updateMessageStatus({ recipientId: selectedChat, messageId, status })));
    socket.on('newContact', (contactData) => {
      setUsers((prev) => [...prev, contactData]);
      localStorage.setItem('cachedUsers', JSON.stringify([...users, contactData]));
    });

    return () => {
      socket.off('message');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
      socket.off('newContact');
    };
  }, [socket, selectedChat, userId, dispatch, decryptMessage, users, chats]);

  useEffect(() => {
    if (selectedChat && chats[selectedChat]) {
      const unreadMessages = chats[selectedChat].filter((msg) => msg.recipientId === userId && msg.status !== 'read');
      setUnreadCount(unreadMessages.length);
      setFirstUnreadMessageId(unreadMessages[0]?._id || null);
      if (isAtBottomRef.current && unreadMessages.length) {
        unreadMessages.forEach((msg) => socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: selectedChat }));
      }
    }
  }, [chats, selectedChat, socket, userId]);

  const renderMessage = ({ index, key, style }) => {
    const messages = chats[selectedChat] || [];
    const msg = messages[index];
    const prevMsg = messages[index - 1];
    const isMine = msg.senderId === userId;
    const showDate = !prevMsg || formatDateHeader(prevMsg.createdAt) !== formatDateHeader(msg.createdAt);
    const isFirstUnread = msg._id === firstUnreadMessageId;

    return (
      <div key={key} style={style}>
        {showDate && (
          <div className="text-center text-gray-500 dark:text-gray-400 my-2">
            <span className="bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded">{formatDateHeader(msg.createdAt)}</span>
          </div>
        )}
        {isFirstUnread && (
          <div className="text-center text-red-500 my-2">
            <span className="bg-red-100 dark:bg-red-900 px-2 py-1 rounded">New Messages</span>
          </div>
        )}
        <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} px-4`}>
          <div className={`max-w-xs md:max-w-md p-3 rounded-lg ${isMine ? 'bg-primary text-white' : 'bg-gray-200 dark:bg-gray-700 dark:text-white'}`}>
            {msg.replyTo && (
              <div className="border-l-4 border-gray-400 pl-2 mb-2 opacity-75">
                <p className="text-sm">{msg.replyTo.content}</p>
              </div>
            )}
            {msg.contentType === 'text' && <p>{msg.content}</p>}
            {msg.contentType === 'image' && <img src={msg.content} alt="Sent image" className="max-w-full rounded" />}
            {msg.contentType === 'video' && (
              <video controls className="max-w-full rounded">
                <source src={msg.content} type="video/mp4" />
              </video>
            )}
            {msg.contentType === 'audio' && (
              <audio controls className="w-full">
                <source src={msg.content} type="audio/mpeg" />
              </audio>
            )}
            {msg.contentType === 'document' && (
              <a href={msg.content} target="_blank" rel="noopener noreferrer" className="flex items-center text-blue-500">
                <FaFileAlt className="mr-2" /> {msg.originalFilename || 'Document'}
              </a>
            )}
            <div className="text-xs mt-1 flex justify-between">
              <span>{formatTime(msg.createdAt)}</span>
              {isMine && (
                <span>{msg.status === 'pending' ? 'Sending...' : msg.status === 'sent' ? '✓' : msg.status === 'read' ? '✓✓' : 'Failed'}</span>
              )}
            </div>
            {msg.status === 'uploading' && (
              <div className="w-full bg-gray-300 rounded h-2 mt-2">
                <div className="bg-primary h-2 rounded" style={{ width: `${uploadProgress[msg.clientMessageId] || 0}%` }}></div>
              </div>
            )}
          </div>
          {isMine && msg.status !== 'uploading' && (
            <FaReply className="ml-2 mt-3 cursor-pointer text-gray-500 hover:text-primary" onClick={() => setReplyTo(msg)} />
          )}
        </div>
      </div>
    );
  };

  const chatListRowRenderer = ({ index, key, style }) => {
    const user = users[index];
    return (
      <div
        key={key}
        style={style}
        className={`flex items-center p-3 border-b dark:border-gray-700 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 ${selectedChat === user.id ? 'bg-secondary text-white' : ''}`}
        onClick={() => dispatch(setSelectedChat(user.id))}
      >
        <img src={user.photo} alt={user.username} className="w-10 h-10 rounded-full mr-3" />
        <div className="flex-1">
          <div className="flex justify-between">
            <span className="font-semibold">{user.username}</span>
            {user.latestMessage && <span className="text-xs text-gray-500 dark:text-gray-400">{formatChatListDate(user.latestMessage.createdAt)}</span>}
          </div>
          <div className="text-sm truncate">{user.latestMessage?.content || 'No messages yet'}</div>
          {user.unreadCount > 0 && (
            <span className="bg-red-500 text-white text-xs rounded-full px-2 py-1">{user.unreadCount}</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-900">
      <div className="bg-primary text-white p-4 flex justify-between items-center">
        <h1 className="text-xl font-bold">Chat</h1>
        <div className="relative">
          <FaEllipsisH className="cursor-pointer" onClick={() => setShowMenu(!showMenu)} />
          {showMenu && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded shadow-lg z-10"
            >
              <div
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer flex items-center"
                onClick={() => setMenuTab(menuTab === 'add' ? '' : 'add')}
              >
                <FaUserPlus className="mr-2" /> Add Contact
              </div>
              <div
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer flex items-center text-red-500"
                onClick={handleLogout}
              >
                <FaSignOutAlt className="mr-2" /> Logout
              </div>
              {menuTab === 'add' && (
                <div className="p-2">
                  <input
                    type="text"
                    value={newContactNumber}
                    onChange={(e) => setNewContactNumber(e.target.value)}
                    placeholder="Virtual Number"
                    className="w-full p-2 border rounded dark:bg-gray-700 dark:text-white"
                  />
                  <button
                    onClick={handleAddContact}
                    className="w-full mt-2 bg-primary text-white p-2 rounded hover:bg-secondary"
                  >
                    Add
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </div>
      </div>
      {error && <div className="p-2 text-center text-red-500">{error}</div>}
      <div className="flex-1 flex overflow-hidden">
        {!selectedChat ? (
          <div className="w-full md:w-1/3 border-r dark:border-gray-700">
            <List
              width={window.innerWidth < 768 ? window.innerWidth : window.innerWidth / 3}
              height={window.innerHeight - 100}
              rowCount={users.length}
              rowHeight={70}
              rowRenderer={chatListRowRenderer}
            />
          </div>
        ) : (
          <div className="flex-1 flex flex-col">
            <div className="bg-white dark:bg-gray-800 p-3 flex items-center border-b dark:border-gray-700">
              <FaArrowLeft className="md:hidden mr-3 cursor-pointer" onClick={() => dispatch(setSelectedChat(null))} />
              <img src={users.find((u) => u.id === selectedChat)?.photo} alt="User" className="w-10 h-10 rounded-full mr-3" />
              <div>
                <h2 className="font-semibold dark:text-white">{users.find((u) => u.id === selectedChat)?.username}</h2>
                {isTyping[selectedChat] && <span className="text-sm text-gray-500 dark:text-gray-400">Typing...</span>}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto" ref={chatRef}>
              <List
                ref={listRef}
                width={window.innerWidth}
                height={window.innerHeight - (selectedChat ? 200 : 100)}
                rowCount={(chats[selectedChat] || []).length}
                rowHeight={100}
                rowRenderer={renderMessage}
                onScroll={handleScroll}
              />
              {showJumpToBottom && (
                <button
                  onClick={jumpToBottom}
                  className="fixed bottom-20 right-4 bg-primary text-white p-2 rounded-full shadow-lg"
                >
                  <FaArrowDown />
                </button>
              )}
            </div>
            {replyTo && (
              <div className="bg-gray-200 dark:bg-gray-700 p-2 flex justify-between items-center">
                <span className="text-sm">Replying to: {replyTo.content.slice(0, 50)}...</span>
                <FaTrash className="cursor-pointer text-red-500" onClick={() => setReplyTo(null)} />
              </div>
            )}
            {mediaPreview.length > 0 && (
              <div className="bg-gray-200 dark:bg-gray-700 p-2 flex flex-wrap">
                {mediaPreview.map((preview, idx) => (
                  <div key={idx} className="relative m-2">
                    {preview.type === 'image' && <img src={preview.url} alt="Preview" className="w-20 h-20 object-cover rounded" />}
                    {preview.type === 'video' && (
                      <video className="w-20 h-20 object-cover rounded">
                        <source src={preview.url} type="video/mp4" />
                      </video>
                    )}
                    {preview.type === 'audio' && <audio controls src={preview.url} className="w-20" />}
                    <FaTrash
                      className="absolute top-0 right-0 text-red-500 cursor-pointer"
                      onClick={() => {
                        setMediaPreview((prev) => prev.filter((_, i) => i !== idx));
                        setFiles((prev) => prev.filter((_, i) => i !== idx));
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="p-3 bg-white dark:bg-gray-800 flex items-center border-t dark:border-gray-700">
              <FaPaperclip className="mr-3 cursor-pointer" onClick={() => setShowPicker(!showPicker)} />
              {showPicker && (
                <div className="absolute bottom-16 left-4 bg-white dark:bg-gray-800 p-2 rounded shadow-lg flex space-x-2">
                  <label className="cursor-pointer">
                    <FaCamera />
                    <input type="file" accept="image/*" onChange={(e) => handleFileChange(e, 'image')} hidden />
                  </label>
                  <label className="cursor-pointer">
                    <FaVideo />
                    <input type="file" accept="video/*" onChange={(e) => handleFileChange(e, 'video')} hidden />
                  </label>
                  <label className="cursor-pointer">
                    <FaMicrophone />
                    <input type="file" accept="audio/*" onChange={(e) => handleFileChange(e, 'audio')} hidden />
                  </label>
                  <label className="cursor-pointer">
                    <FaFileAlt />
                    <input type="file" onChange={(e) => handleFileChange(e, 'document')} hidden />
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
                onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Type a message..."
                className="flex-1 p-2 border rounded dark:bg-gray-700 dark:text-white dark:border-gray-600"
              />
              <FaPaperPlane className="ml-3 cursor-pointer text-primary" onClick={sendMessage} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default ChatScreen;