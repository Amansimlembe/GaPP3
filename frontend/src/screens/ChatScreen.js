import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import forge from 'node-forge';
import {
  FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply, FaEllipsisH, FaForward, FaFileAlt,
  FaPlay, FaArrowDown, FaUserPlus, FaSignOutAlt, FaUser, FaCopy, FaClock, FaCamera, FaVideo, FaMapMarkerAlt, FaAddressCard,
} from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import { setMessages, addMessage, updateMessageStatus, setSelectedChat, resetState, replaceMessage } from '../store';
import { saveMessages, getMessages, clearOldMessages, deleteMessage, savePendingMessages, loadPendingMessages } from '../db';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const ChatScreen = React.memo(({ token, userId, setAuth, socket }) => {
  const dispatch = useDispatch();
  const { chats, selectedChat } = useSelector((state) => state.messages);
  const [users, setUsers] = useState(() => JSON.parse(localStorage.getItem('cachedUsers')) || []);
  const [message, setMessage] = useState('');
  const [file, setFile] = useState(null);
  const [caption, setCaption] = useState('');
  const [contentType, setContentType] = useState('text');
  const [notifications, setNotifications] = useState(() => JSON.parse(localStorage.getItem('chatNotifications')) || {});
  const [typing, setTyping] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [menuTab, setMenuTab] = useState('');
  const [newContactNumber, setNewContactNumber] = useState('');
  const [error, setError] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMessageMenu, setShowMessageMenu] = useState(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [mediaPreview, setMediaPreview] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [viewMedia, setViewMedia] = useState(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [userStatus, setUserStatus] = useState({ status: 'offline', lastSeen: null });
  const [pendingMessages, setPendingMessages] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({});
  const chatRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const lastFetchedAtRef = useRef(null);
  const messagesPerPage = 50;
  const isSmallDevice = window.innerWidth < 768;

  const handleLogout = useCallback(() => {
    socket.emit('leave', userId);
    dispatch(resetState());
    localStorage.clear();
    setUsers([]);
    setNotifications({});
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
    const { data } = await axios.get(`${BASE_URL}/auth/public_key/${recipientId}`, { headers: { Authorization: `Bearer ${token}` } });
    return data.publicKey;
  }, [token]);

  const formatChatListDate = (date) => new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const formatDateHeader = (date) => {
    const today = new Date();
    const msgDate = new Date(date);
    if (msgDate.toDateString() === today.toDateString()) return 'Today';
    today.setDate(today.getDate() - 1);
    if (msgDate.toDateString() === today.toDateString()) return 'Yesterday';
    return msgDate.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: '2-digit' });
  };
  const formatTime = (date) => new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const formatLastSeen = (lastSeen) => (lastSeen ? `Last seen ${new Date(lastSeen).toLocaleString()}` : 'Offline');

  const fetchChatList = useCallback(async () => {
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

  const fetchMessages = useCallback(async (recipientId, pageNum = 0, syncOnly = false) => {
    if (!recipientId || loading || (!hasMore && !syncOnly)) return;
    setLoading(true);
    try {
      const localMessages = await getMessages(recipientId);
      if (!syncOnly && localMessages.length && pageNum === 0) {
        dispatch(setMessages({ recipientId, messages: localMessages }));
        lastFetchedAtRef.current = localMessages[localMessages.length - 1]?.createdAt || null;
        chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
      }

      const params = {
        userId,
        recipientId,
        limit: messagesPerPage,
        skip: pageNum * messagesPerPage,
        since: syncOnly && lastFetchedAtRef.current ? new Date(lastFetchedAtRef.current).toISOString() : undefined,
      };
      const { data } = await axios.get(`${BASE_URL}/social/messages`, { headers: { Authorization: `Bearer ${token}` }, params });
      const privateKeyPem = localStorage.getItem('privateKey');
      const messages = await Promise.all(data.messages.map(async (msg) => {
        const newMsg = { ...msg };
        if (msg.senderId === userId) {
          newMsg.content = msg.plaintextContent || msg.content;
        } else if (msg.recipientId === userId) {
          newMsg.content = msg.contentType === 'text'
            ? await decryptMessage(msg.content, privateKeyPem)
            : msg.content; // Cloudinary URL for media
        }
        return newMsg;
      }));

      if (syncOnly) {
        messages.forEach((msg) => {
          if (!chats[recipientId]?.some((m) => m._id === msg._id)) {
            dispatch(addMessage({ recipientId, message: msg }));
          }
        });
      } else {
        dispatch(setMessages({ recipientId, messages: [...(chats[recipientId] || []).filter((m) => !messages.some((nm) => nm._id === m._id)), ...messages] }));
      }
      setHasMore(data.hasMore);
      await saveMessages(messages);
      lastFetchedAtRef.current = messages[messages.length - 1]?.createdAt || lastFetchedAtRef.current;
    } catch (err) {
      setError(`Failed to load messages: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [token, userId, dispatch, decryptMessage, loading, hasMore, chats]);

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
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;
    setFile(selectedFile);
    setContentType(type);
    setMediaPreview({ type, url: URL.createObjectURL(selectedFile) });
    setShowPicker(false);

    const clientMessageId = `${userId}-${Date.now()}-${Math.random().toString(36).substring(2)}`;
    const tempMessage = {
      _id: clientMessageId,
      senderId: userId,
      recipientId: selectedChat,
      contentType: type,
      content: URL.createObjectURL(selectedFile),
      status: 'uploading',
      createdAt: new Date(),
      originalFilename: selectedFile.name,
      uploadProgress: 0,
      clientMessageId,
    };

    dispatch(addMessage({ recipientId: selectedChat, message: tempMessage }));
    if (isAtBottomRef.current) chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });

    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('userId', userId);
    formData.append('recipientId', selectedChat);
    formData.append('clientMessageId', clientMessageId);

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
      setFile(null);
      setMediaPreview(null);
    }
  };

  useEffect(() => {
    if (!userId || !token) return;

    const initializeChat = async () => {
      await fetchChatList();
      const pending = await loadPendingMessages();
      setPendingMessages(pending);
      const keepAlive = setInterval(() => socket.emit('ping', { userId }), 3000);
      clearOldMessages(30).catch((err) => console.error('IndexedDB error:', err));

      if (selectedChat) {
        await fetchMessages(selectedChat, 0);
        fetchMessages(selectedChat, 0, true); // Initial sync
      }

      const onlineHandler = () => sendPendingMessages();
      window.addEventListener('online', onlineHandler);

      return () => {
        clearInterval(keepAlive);
        window.removeEventListener('online', onlineHandler);
      };
    };

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
      setShowJumpToBottom(!isAtBottomRef.current);
      if (scrollTop < 50 && hasMore && !loading) setPage((prev) => prev + 1);
      if (isAtBottomRef.current && selectedChat) {
        const unread = (chats[selectedChat] || []).filter((m) => m.recipientId === userId && m.status !== 'read');
        unread.forEach((m) => socket.emit('messageStatus', { messageId: m._id, status: 'read', recipientId: userId }));
        setUnreadCount(0);
      }
    };

    const setupSocketListeners = () => {
      socket.on('connect', () => {
        socket.emit('join', userId);
        sendPendingMessages();
      });

      socket.on('message', async (msg) => {
        const chatId = msg.senderId === userId ? msg.recipientId : msg.senderId;
        if (chats[chatId]?.some((m) => m._id === msg._id || m.clientMessageId === msg.clientMessageId)) return;

        const privateKeyPem = localStorage.getItem('privateKey');
        const content = msg.senderId === userId ? msg.plaintextContent || msg.content : msg.contentType === 'text'
          ? await decryptMessage(msg.content, privateKeyPem)
          : msg.content;

        const newMsg = { ...msg, content };
        dispatch(addMessage({ recipientId: chatId, message: newMsg }));
        await saveMessages([newMsg]);

        setUsers((prev) => {
          const updated = prev.map((u) => u.id === chatId ? { ...u, latestMessage: { ...newMsg, content: msg.senderId === userId ? `You: ${msg.plaintextContent || `[${msg.contentType}]`}` : content }, unreadCount: msg.recipientId === userId && chatId !== selectedChat ? (u.unreadCount || 0) + 1 : u.unreadCount } : u);
          const sorted = updated.sort((a, b) => new Date(b.latestMessage?.createdAt || 0) - new Date(a.latestMessage?.createdAt || 0));
          localStorage.setItem('cachedUsers', JSON.stringify(sorted));
          return sorted;
        });

        if (chatId === selectedChat && isAtBottomRef.current) {
          chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
        } else if (chatId === selectedChat) {
          setUnreadCount((prev) => prev + 1);
          if (!firstUnreadMessageId) setFirstUnreadMessageId(msg._id);
        }
      });

      socket.on('messageStatus', ({ messageId, status }) => {
        Object.keys(chats).forEach((chatId) => {
          if (chats[chatId]?.some((m) => m._id === messageId)) {
            dispatch(updateMessageStatus({ recipientId: chatId, messageId, status }));
          }
        });
      });

      socket.on('typing', ({ userId: senderId }) => setIsTyping((prev) => ({ ...prev, [senderId]: true })));
      socket.on('stopTyping', ({ userId: senderId }) => setIsTyping((prev) => ({ ...prev, [senderId]: false })));

      socket.on('onlineStatus', ({ userId: contactId, status, lastSeen }) => {
        setUsers((prev) => {
          const updated = prev.map((u) => (u.id === contactId ? { ...u, status, lastSeen } : u));
          localStorage.setItem('cachedUsers', JSON.stringify(updated));
          return updated;
        });
        if (contactId === selectedChat) setUserStatus({ status, lastSeen });
      });
    };

    initializeChat().then(setupSocketListeners);
    chatRef.current?.addEventListener('scroll', handleScroll);

    return () => {
      socket.off('connect');
      socket.off('message');
      socket.off('messageStatus');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('onlineStatus');
      chatRef.current?.removeEventListener('scroll', handleScroll);
    };
  }, [token, userId, selectedChat, dispatch, fetchChatList, fetchMessages, chats, decryptMessage, socket, sendPendingMessages, hasMore, loading]);

  const sendMessage = async () => {
    if (!selectedChat || (!message.trim() && !file)) return;
    socket.emit('stopTyping', { userId, recipientId: selectedChat });
    setTyping(false);

    const tempId = `${userId}-${Date.now()}`;
    const plaintextContent = file ? file.name : message;
    const tempMsg = { _id: tempId, senderId: userId, recipientId: selectedChat, contentType, content: file ? URL.createObjectURL(file) : message, caption, status: navigator.onLine ? 'sent' : 'pending', replyTo: replyTo?._id, createdAt: new Date(), originalFilename: file?.name, clientMessageId: tempId };
    dispatch(addMessage({ recipientId: selectedChat, message: tempMsg }));
    if (isAtBottomRef.current) chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });

    setMessage('');
    setFile(null);
    setCaption('');
    setContentType('text');
    setReplyTo(null);
    setMediaPreview(null);
    setShowPicker(false);

    if (!navigator.onLine) {
      const newPending = [...pendingMessages, { tempId, recipientId: selectedChat, messageData: tempMsg }];
      setPendingMessages(newPending);
      await savePendingMessages(newPending);
      return;
    }

    try {
      const recipientPublicKey = await getPublicKey(selectedChat);
      const encryptedContent = contentType === 'text' && !file
        ? await encryptMessage(message, recipientPublicKey)
        : file ? await encryptMessage(await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsBinaryString(file); }), recipientPublicKey, true) : null;

      const messageData = { senderId: userId, recipientId: selectedChat, contentType, content: encryptedContent, plaintextContent: contentType === 'text' ? message : '', caption: caption || undefined, replyTo: replyTo?._id || undefined, originalFilename: file?.name || undefined, clientMessageId: tempId };
      const { data } = await axios.post(`${BASE_URL}/social/message`, messageData, { headers: { Authorization: `Bearer ${token}` } });
      dispatch(replaceMessage({ recipientId: selectedChat, message: { ...data, content: data.plaintextContent || data.content }, replaceId: tempId }));
      await saveMessages([{ ...data, content: data.plaintextContent || data.content }]);
    } catch (err) {
      console.error('Send error:', err);
      setError(`Send failed: ${err.message}`);
    }
  };

  const handleTyping = useCallback((e) => {
    setMessage(e.target.value);
    if (!typing && e.target.value) {
      socket.emit('typing', { userId, recipientId: selectedChat });
      setTyping(true);
    }
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stopTyping', { userId, recipientId: selectedChat });
      setTyping(false);
    }, 2000);
  }, [typing, userId, selectedChat, socket]);

  const messagesList = useMemo(() => (
    (chats[selectedChat] || []).map((msg, i) => {
      const showDateHeader = i === 0 || new Date(msg.createdAt).toDateString() !== new Date(chats[selectedChat][i - 1].createdAt).toDateString();
      return (
        <motion.div key={msg._id || msg.clientMessageId} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          {showDateHeader && <div className="text-center my-2"><span className="bg-gray-300 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-1 rounded-full text-sm">{formatDateHeader(msg.createdAt)}</span></div>}
          {firstUnreadMessageId === msg._id && unreadCount > 0 && <div className="text-center my-2"><span className="bg-blue-500 text-white px-2 py-1 rounded-full text-sm">{unreadCount} New Messages</span></div>}
          <div className={`flex ${msg.senderId === userId ? 'justify-end' : 'justify-start'} px-2 py-1`}>
            <div className={`max-w-[70%] p-2 rounded-lg shadow-sm relative ${msg.senderId === userId ? 'bg-green-500 text-white rounded-br-none' : 'bg-white dark:bg-gray-800 rounded-bl-none'}`}>
              {msg.replyTo && <div className="text-xs italic mb-1 bg-gray-200 dark:bg-gray-700 p-1 rounded">{chats[selectedChat].find((m) => m._id === msg.replyTo)?.content || 'Original message not found'}</div>}
              {msg.contentType === 'text' && <p className="text-sm break-words">{msg.content}</p>}
              {msg.contentType !== 'text' && (
                <div className="relative">
                  {msg.status === 'uploading' && (
                    <div className="absolute inset-0 flex items-center justify-center bg-gray-500 bg-opacity-50 rounded-lg">
                      <span className="text-white text-sm">{msg.uploadProgress || 0}%</span>
                    </div>
                  )}
                  {msg.contentType === 'image' && <img src={msg.content} alt="Chat" className="max-w-[80%] max-h-64 rounded-lg cursor-pointer" onClick={() => setViewMedia({ type: 'image', url: msg.content })} />}
                  {msg.contentType === 'video' && <video src={msg.content} className="max-w-[80%] max-h-64 rounded-lg" controls />}
                  {msg.contentType === 'audio' && <audio src={msg.content} controls className="max-w-[80%]" />}
                  {msg.contentType === 'document' && <div className="flex items-center"><FaFileAlt className="text-blue-600 mr-2" /><a href={msg.content} download={msg.originalFilename} className="text-blue-600 truncate">{msg.originalFilename || 'file'}</a></div>}
                </div>
              )}
              {msg.caption && <p className="text-xs italic mt-1">{msg.caption}</p>}
              <div className="flex justify-between mt-1">
                {msg.senderId === userId && (
                  <span className="text-xs">{msg.status === 'pending' ? <FaClock /> : msg.status === 'sent' ? '✔' : msg.status === 'delivered' ? '✔✔' : <span className="text-blue-300">✔✔</span>}</span>
                )}
                <span className="text-xs text-gray-500">{formatTime(msg.createdAt)}</span>
              </div>
            </div>
          </div>
        </motion.div>
      );
    })
  ), [chats, selectedChat, userId, unreadCount, firstUnreadMessageId]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex h-screen bg-gray-100 dark:bg-gray-900">
      <div className={`w-full md:w-1/3 bg-white dark:bg-gray-800 border-r ${isSmallDevice && selectedChat ? 'hidden' : 'block'} flex flex-col`}>
        <div className="p-4 flex justify-between border-b dark:border-gray-700">
          <h2 className="text-xl font-bold text-primary dark:text-gray-100">Chats</h2>
          <FaEllipsisH onClick={() => setShowMenu(true)} className="text-2xl text-primary dark:text-gray-100 cursor-pointer" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {users.map((user) => (
            <motion.div
              key={user.id}
              onClick={() => { dispatch(setSelectedChat(user.id)); setNotifications((prev) => ({ ...prev, [user.id]: 0 })); }}
              className={`flex items-center p-3 border-b dark:border-gray-700 cursor-pointer ${selectedChat === user.id ? 'bg-gray-100 dark:bg-gray-700' : ''}`}
              whileHover={{ backgroundColor: '#f0f0f0' }}
            >
              <div className="relative">
                <img src={user.photo || 'https://placehold.co/40x40'} alt="Profile" className="w-12 h-12 rounded-full mr-3" />
                {user.status === 'online' && <span className="absolute bottom-0 right-3 w-3 h-3 bg-green-500 rounded-full border-2 border-white dark:border-gray-800"></span>}
              </div>
              <div className="flex-1">
                <div className="flex justify-between">
                  <span className="font-semibold dark:text-gray-100">{user.username || user.virtualNumber}</span>
                  {user.latestMessage && <span className="text-xs text-gray-500 dark:text-gray-400">{formatChatListDate(user.latestMessage.createdAt)}</span>}
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600 dark:text-gray-300 truncate w-3/4">{user.latestMessage?.content || 'No messages'}</span>
                  {user.unreadCount > 0 && <span className="bg-green-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">{user.unreadCount}</span>}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      <div className={`flex-1 flex flex-col ${isSmallDevice && !selectedChat ? 'hidden' : 'block'}`}>
        {selectedChat ? (
          <>
            <div className="bg-white dark:bg-gray-800 p-3 flex items-center justify-between border-b dark:border-gray-700 fixed top-0 md:left-[33.33%] md:w-2/3 left-0 right-0 z-10">
              <div className="flex items-center">
                <FaArrowLeft onClick={() => dispatch(setSelectedChat(null))} className="text-xl text-primary dark:text-gray-100 cursor-pointer mr-3" />
                <img src={users.find((u) => u.id === selectedChat)?.photo || 'https://placehold.co/40x40'} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
                <div>
                  <span className="font-semibold dark:text-gray-100">{users.find((u) => u.id === selectedChat)?.username || users.find((u) => u.id === selectedChat)?.virtualNumber || 'Unknown'}</span>
                  <div className="text-sm text-gray-500 dark:text-gray-400">{isTyping[selectedChat] ? 'Typing...' : userStatus.status === 'online' ? 'Online' : formatLastSeen(userStatus.lastSeen)}</div>
                </div>
              </div>
            </div>
            <div ref={chatRef} className="flex-1 overflow-y-auto bg-gray-100 dark:bg-gray-900 p-2 pt-16" style={{ paddingBottom: '80px' }}>
              {messagesList}
              {showJumpToBottom && (
                <button onClick={() => chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' })} className="fixed bottom-20 right-4 bg-primary text-white p-2 rounded-full">
                  <FaArrowDown />
                </button>
              )}
            </div>

            <motion.div className="bg-white dark:bg-gray-800 p-2 border-t dark:border-gray-700 fixed md:left-[33.33%] md:w-2/3 left-0 right-0 bottom-0 z-30">
              {replyTo && (
                <div className="bg-gray-100 dark:bg-gray-700 p-2 mb-2 rounded relative">
                  <p className="text-sm">Replying to: {replyTo.content}</p>
                  <button onClick={() => setReplyTo(null)} className="absolute top-2 right-2 bg-red-500 text-white p-1 rounded-full"><FaTrash /></button>
                </div>
              )}
              {mediaPreview && (
                <div className="bg-gray-100 dark:bg-gray-700 p-2 mb-2 rounded relative">
                  {mediaPreview.type === 'image' && <img src={mediaPreview.url} alt="Preview" className="max-w-full max-h-64 rounded-lg" />}
                  {mediaPreview.type === 'video' && <video src={mediaPreview.url} className="max-w-full max-h-64 rounded-lg" controls />}
                  {mediaPreview.type === 'audio' && <audio src={mediaPreview.url} controls />}
                  {mediaPreview.type === 'document' && <div className="flex"><FaFileAlt className="text-blue-600 mr-2" /><span className="text-blue-600 truncate">{file.name}</span></div>}
                  <input type="text" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Add a caption..." className="w-full p-1 mt-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600" />
                  <button onClick={() => { setMediaPreview(null); setFile(null); sendMessage(); }} className="absolute top-2 right-2 bg-green-500 text-white p-1 rounded-full"><FaPaperPlane /></button>
                </div>
              )}
              <div className="flex items-center">
                <FaPaperclip onClick={() => setShowPicker((prev) => !prev)} className="text-xl text-primary dark:text-gray-100 cursor-pointer mr-2" />
                <AnimatePresence>
                  {showPicker && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute bottom-12 left-2 bg-white dark:bg-gray-800 p-4 rounded-lg shadow-lg z-20 grid grid-cols-3 gap-4 w-64"
                    >
                      <label className="flex flex-col items-center cursor-pointer"><FaCamera className="text-blue-600" /><span className="text-xs">Photo</span><input type="file" accept="image/*" onChange={(e) => handleFileChange(e, 'image')} className="hidden" /></label>
                      <label className="flex flex-col items-center cursor-pointer"><FaVideo className="text-green-500" /><span className="text-xs">Video</span><input type="file" accept="video/*" onChange={(e) => handleFileChange(e, 'video')} className="hidden" /></label>
                      <label className="flex flex-col items-center cursor-pointer"><FaPlay className="text-purple-500" /><span className="text-xs">Audio</span><input type="file" accept="audio/*" onChange={(e) => handleFileChange(e, 'audio')} className="hidden" /></label>
                      <label className="flex flex-col items-center cursor-pointer"><FaFileAlt className="text-red-500" /><span className="text-xs">Document</span><input type="file" accept=".pdf,.doc,.docx" onChange={(e) => handleFileChange(e, 'document')} className="hidden" /></label>
                      <div className="flex flex-col items-center cursor-pointer"><FaAddressCard className="text-yellow-500" /><span className="text-xs">Contact</span></div>
                      <div className="flex flex-col items-center cursor-pointer"><FaMapMarkerAlt className="text-orange-500" /><span className="text-xs">Location</span></div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <input type="text" value={message} onChange={handleTyping} onKeyPress={(e) => e.key === 'Enter' && sendMessage()} placeholder="Type a message..." className="flex-1 p-2 border rounded-lg mr-2 dark:bg-gray-700 dark:text-white dark:border-gray-600" disabled={loading} />
                <FaPaperPlane onClick={sendMessage} className="text-xl text-primary dark:text-gray-100 cursor-pointer" />
              </div>
            </motion.div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center"><p className="text-gray-500 dark:text-gray-400">Select a chat to start messaging</p></div>
        )}
      </div>
    </motion.div>
  );
});

export default ChatScreen;