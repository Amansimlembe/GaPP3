import React, { useState, useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import forge from 'node-forge';
import {
  FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply, FaEllipsisH, FaForward, FaFileAlt,
  FaPlay, FaArrowDown, FaUserPlus, FaSignOutAlt,
} from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import { setMessages, addMessage, updateMessageStatus, setSelectedChat, resetState } from '../store';
import { saveMessages, getMessages, clearOldMessages, deleteMessage, checkIndexes } from '../db';

const socket = io('https://gapp-6yc3.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  withCredentials: true,
});

const ChatScreen = ({ token, userId, setAuth }) => {
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
  const chatRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const messagesPerPage = 50;
  const isSmallDevice = window.innerWidth < 768;

  const encryptMessage = useCallback(async (content, recipientPublicKey, isMedia = false) => {
    const publicKey = forge.pki.publicKeyFromPem(recipientPublicKey);
    const buffer = isMedia ? forge.util.createBuffer(content, 'raw') : forge.util.encodeUtf8(content);
    return forge.util.encode64(publicKey.encrypt(buffer, 'RSA-OAEP', { md: forge.md.sha256.create() }));
  }, []);

  const decryptMessage = useCallback(async (encryptedContent, privateKeyPem, isMedia = false) => {
    try {
      if (!privateKeyPem || !privateKeyPem.includes('-----BEGIN RSA PRIVATE KEY-----')) {
        console.error('Invalid private key detected, attempting refresh', { privateKeyPem });
        const { data } = await axios.post('https://gapp-6yc3.onrender.com/auth/refresh', {}, { headers: { Authorization: `Bearer ${token}` } });
        localStorage.setItem('privateKey', data.privateKey);
        localStorage.setItem('token', data.token);
        privateKeyPem = data.privateKey;
        if (!privateKeyPem.includes('-----BEGIN RSA PRIVATE KEY-----')) {
          throw new Error('Invalid private key after refresh');
        }
      }
      const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
      const decrypted = privateKey.decrypt(forge.util.decode64(encryptedContent), 'RSA-OAEP', { md: forge.md.sha256.create() });
      return isMedia ? decrypted : forge.util.decodeUtf8(decrypted);
    } catch (err) {
      console.error('Decryption error:', err.message);
      return '[Decryption Failed]';
    }
  }, [token]);

  const getPublicKey = useCallback(async (recipientId) => {
    try {
      const { data } = await axios.get(`https://gapp-6yc3.onrender.com/auth/public_key/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return data.publicKey;
    } catch (err) {
      console.error('Get public key error:', err.response?.data || err);
      throw err;
    }
  }, [token]);

  const formatChatListDate = (date) => new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const formatDateHeader = (date) => new Date(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const formatTime = (date) => new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const formatLastSeen = (lastSeen) => (lastSeen ? `Last seen ${new Date(lastSeen).toLocaleString()}` : 'Offline');

  const retryRequest = async (url, config, retries = 3, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await axios.get(url, config);
        return response;
      } catch (err) {
        if (err.response?.status === 429 && i < retries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
          continue;
        }
        throw err;
      }
    }
  };

  useEffect(() => {
    if (!userId || !token) return;

    const initialize = async () => {
      try {
        let privateKeyPem = localStorage.getItem('privateKey');
        if (!privateKeyPem || !privateKeyPem.includes('-----BEGIN RSA PRIVATE KEY-----')) {
          for (let i = 0; i < 3; i++) {
            try {
              const response = await axios.post(
                'https://gapp-6yc3.onrender.com/auth/refresh',
                {},
                { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
              );
              const { data } = response;
              localStorage.setItem('privateKey', data.privateKey);
              localStorage.setItem('token', data.token);
              privateKeyPem = data.privateKey;
              break;
            } catch (err) {
              if (err.response?.status === 401 && i < 2) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
                continue;
              }
              throw err;
            }
          }
        }
        socket.emit('join', userId);
        await fetchUsers();
        if (selectedChat) await fetchMessages(0);
      } catch (err) {
        console.error('Initialization error:', err.response?.data || err);
        handleLogout();
      }
    };

  initialize();

    const keepAlive = setInterval(() => socket.emit('ping', { userId }), 30000);
    clearOldMessages(30).then(() => checkIndexes()).catch((err) => console.error('IndexedDB setup error:', err));

    const fetchUsers = async () => {
      try {
        if (!token || !userId) {
          setError('Missing token or userId');
          console.error('Missing token or userId:', { token, userId });
          return;
        }
        const { data } = await retryRequest('https://gapp-6yc3.onrender.com/auth/contacts', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const usersWithData = await Promise.all(data.map(async (user) => {
          const { data: msgData } = await retryRequest('https://gapp-6yc3.onrender.com/social/messages', {
            headers: { Authorization: `Bearer ${token}` },
            params: { userId, recipientId: user.id, limit: 1, skip: 0 },
          });
          return {
            ...user,
            latestMessage: msgData.messages[0],
            unreadCount: msgData.messages[0]?.recipientId === userId && msgData.messages[0]?.status !== 'read' ? 1 : 0,
          };
        }));
        const { data: currentUser } = await axios.post('https://gapp-6yc3.onrender.com/auth/refresh', { headers: { Authorization: `Bearer ${token}` } });
        setUsers((prev) => {
          const updatedUsers = usersWithData.map((u) => (u.id === userId ? { ...u, photo: currentUser.photo } : u)).sort((a, b) => new Date(b.latestMessage?.createdAt || 0) - new Date(a.latestMessage?.createdAt || 0));
          localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
          return updatedUsers;
        });
      } catch (err) {
        setError(`Failed to load contacts: ${err.response?.data?.error || err.message}`);
        console.error('Fetch users error:', err.response?.data || err);
        if (err.response?.status === 401 || err.response?.status === 404) handleLogout();
      }
    };

    const fetchMessages = async (pageNum = 0, initial = true) => {
      if (!selectedChat || loading || !hasMore) return;
      setLoading(true);
      try {
        const { data } = await retryRequest('https://gapp-6yc3.onrender.com/social/messages', {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId: selectedChat, limit: messagesPerPage, skip: pageNum * messagesPerPage },
        });
        let privateKeyPem = localStorage.getItem('privateKey');
        if (!privateKeyPem || !privateKeyPem.includes('-----BEGIN RSA PRIVATE KEY-----')) {
          const { data: refreshData } = await axios.post('https://gapp-6yc3.onrender.com/auth/refresh', {}, { headers: { Authorization: `Bearer ${token}` } });
          localStorage.setItem('privateKey', refreshData.privateKey);
          localStorage.setItem('token', refreshData.token);
          privateKeyPem = refreshData.privateKey;
        }
        const messages = await Promise.all(data.messages.map(async (msg) => {
          if (msg.recipientId === userId) {
            if (msg.contentType === 'text') {
              msg.content = await decryptMessage(msg.content, privateKeyPem);
            } else if (['image', 'video', 'audio', 'document'].includes(msg.contentType)) {
              const decryptedContent = await decryptMessage(msg.content, privateKeyPem, true);
              msg.content = URL.createObjectURL(new Blob([decryptedContent], { type: msg.contentType === 'document' ? 'application/pdf' : msg.contentType }));
              msg.originalFilename = msg.originalFilename || 'file';
            }
          }
          return msg;
        }));
        setHasMore(data.hasMore);
        dispatch(setMessages({ recipientId: selectedChat, messages: initial ? messages : [...messages, ...(chats[selectedChat] || [])] }));
        if (initial) {
          const unread = messages.filter((m) => m.recipientId === userId && m.status !== 'read');
          setUnreadCount(unread.length);
          if (unread.length) setFirstUnreadMessageId(unread[0]._id);
          chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
        }
        await saveMessages(messages);
      } catch (err) {
        setError(`Failed to load messages: ${err.response?.data?.error || err.message}`);
        console.error('Fetch messages error:', err.response?.data || err);
      } finally {
        setLoading(false);
      }
    };

    if (selectedChat) {
      setPage(0);
      setHasMore(true);
      fetchMessages(0);
      retryRequest(`https://gapp-6yc3.onrender.com/social/user-status/${selectedChat}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(({ data }) => setUserStatus(data)).catch(() => setUserStatus({ status: 'offline', lastSeen: null }));
    }

    socket.on('message', async (msg) => {
      const chatId = msg.senderId === userId ? msg.recipientId : msg.senderId;
      let privateKeyPem = localStorage.getItem('privateKey');
      if (!privateKeyPem || !privateKeyPem.includes('-----BEGIN RSA PRIVATE KEY-----')) {
        const { data } = await axios.post('https://gapp-6yc3.onrender.com/auth/refresh', {}, { headers: { Authorization: `Bearer ${token}` } });
        localStorage.setItem('privateKey', data.privateKey);
        localStorage.setItem('token', data.token);
        privateKeyPem = data.privateKey;
      }
      if (msg.recipientId === userId) {
        if (msg.contentType === 'text') {
          msg.content = await decryptMessage(msg.content, privateKeyPem);
        } else if (['image', 'video', 'audio', 'document'].includes(msg.contentType)) {
          const decryptedContent = await decryptMessage(msg.content, privateKeyPem, true);
          msg.content = URL.createObjectURL(new Blob([decryptedContent], { type: msg.contentType === 'document' ? 'application/pdf' : msg.contentType }));
          msg.originalFilename = msg.originalFilename || 'file';
        }
      }
      dispatch(addMessage({ recipientId: chatId, message: msg }));
      await saveMessages([msg]);

      if (chatId === selectedChat) {
        if (msg.recipientId === userId) {
          socket.emit('messageStatus', { messageId: msg._id, status: 'delivered', recipientId: userId });
          if (isAtBottomRef.current) {
            socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
            chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
          } else {
            setUnreadCount((prev) => prev + 1);
            if (!firstUnreadMessageId) setFirstUnreadMessageId(msg._id);
            setShowJumpToBottom(true);
          }
        }
      } else if (msg.recipientId === userId) {
        setNotifications((prev) => ({ ...prev, [msg.senderId]: (prev[msg.senderId] || 0) + 1 }));
        setUsers((prev) => prev.map((u) => u.id === msg.senderId ? { ...u, unreadCount: (u.unreadCount || 0) + 1, latestMessage: msg } : u));
      }
    });

    socket.on('typing', ({ userId: typer, recipientId }) => {
      if (recipientId === userId && typer === selectedChat) setIsTyping((prev) => ({ ...prev, [typer]: true }));
    });

    socket.on('stopTyping', ({ userId: typer, recipientId }) => {
      if (recipientId === userId && typer === selectedChat) setIsTyping((prev) => ({ ...prev, [typer]: false }));
    });

    socket.on('messageStatus', ({ messageId, status }) => {
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId, status }));
      if (status === 'read') setUnreadCount(0);
    });

    socket.on('onlineStatus', ({ userId: contactId, status, lastSeen }) => {
      setUsers((prev) => prev.map((u) => u.id === contactId ? { ...u, status, lastSeen } : u));
      if (contactId === selectedChat) setUserStatus({ status, lastSeen });
    });

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
      setShowJumpToBottom(!isAtBottomRef.current);
      if (scrollTop < 50 && hasMore && !loading) setPage((prev) => prev + 1);
      if (isAtBottomRef.current) {
        const unread = (chats[selectedChat] || []).filter((m) => m.recipientId === userId && m.status !== 'read');
        unread.forEach((m) => socket.emit('messageStatus', { messageId: m._id, status: 'read', recipientId: userId }));
        setUnreadCount(0);
      }
    };
    chatRef.current?.addEventListener('scroll', handleScroll);
    if (page > 0) fetchMessages(page, false);

    return () => {
      socket.off('message');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
      socket.off('onlineStatus');
      chatRef.current?.removeEventListener('scroll', handleScroll);
      clearInterval(keepAlive);
    };
  }, [token, userId, selectedChat, page, dispatch, getPublicKey, decryptMessage]);

  const sendMessage = async () => {
    if (!selectedChat || (!message && !file)) return;
    socket.emit('stopTyping', { userId, recipientId: selectedChat });
    setTyping(false);
  
    const tempId = Date.now().toString();
    const tempMsg = {
      _id: tempId,
      senderId: userId,
      recipientId: selectedChat,
      contentType,
      content: file ? URL.createObjectURL(file) : message,
      caption,
      status: 'sending',
      replyTo: replyTo?._id,
      createdAt: new Date(),
    };
    dispatch(addMessage({ recipientId: selectedChat, message: tempMsg }));
    if (isAtBottomRef.current) chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  
    try {
      const formData = new FormData();
      formData.append('senderId', userId);
      formData.append('recipientId', selectedChat);
      formData.append('contentType', contentType);
      const recipientPublicKey = await getPublicKey(selectedChat);
  
      if (contentType === 'text' && !file) {
        formData.append('content', await encryptMessage(message, recipientPublicKey));
      } else if (file) {
        // Read file as binary string
        const fileReader = new FileReader();
        const fileContent = await new Promise((resolve) => {
          fileReader.onload = () => resolve(fileReader.result);
          fileReader.readAsBinaryString(file);
        });
        const encryptedContent = await encryptMessage(fileContent, recipientPublicKey, true);
        formData.append('content', encryptedContent);
        formData.append('originalFilename', file.name); // Send original filename for reference
      }
      if (caption) formData.append('caption', caption);
      if (replyTo) formData.append('replyTo', replyTo._id);
  
      const { data } = await axios.post('https://gapp-6yc3.onrender.com/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: tempId, status: 'sent' }));
      dispatch(addMessage({ recipientId: selectedChat, message: data }));
      await saveMessages([data]);
    } catch (err) {
      setError(`Send failed: ${err.response?.data?.error || err.message}`);
      console.error('Send message error:', err.response?.data || err);
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: tempId, status: 'failed' }));
    } finally {
      setMessage('');
      setFile(null);
      setCaption('');
      setContentType('text');
      setReplyTo(null);
      setMediaPreview(null);
      setShowPicker(false);
    }
  };

  const handleTyping = (e) => {
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
  };

  const deleteMessages = async () => {
    try {
      await Promise.all((chats[selectedChat] || [])
        .filter((m) => m._id === showMessageMenu && m.senderId === userId)
        .map((m) => axios.delete(`https://gapp-6yc3.onrender.com/social/message/${m._id}`, { headers: { Authorization: `Bearer ${token}` } }).then(() => deleteMessage(m._id))));
      dispatch(setMessages({ recipientId: selectedChat, messages: (chats[selectedChat] || []).filter((m) => m._id !== showMessageMenu) }));
      setShowDeleteConfirm(false);
    } catch (err) {
      setError(`Failed to delete message: ${err.response?.data?.error || err.message}`);
      console.error('Delete message error:', err.response?.data || err);
    } finally {
      setShowMessageMenu(null);
    }
  };

  const forwardMessage = async (msg) => {
    const number = prompt('Enter virtual number to forward to:');
    const contact = users.find((u) => u.virtualNumber === number);
    if (!contact) return setError('User not found');
    try {
      const publicKey = await getPublicKey(contact.id);
      const encryptedContent = await encryptMessage(msg.content, publicKey, ['image', 'video', 'audio', 'document'].includes(msg.contentType));
      const formData = new FormData();
      formData.append('senderId', userId);
      formData.append('recipientId', contact.id);
      formData.append('contentType', msg.contentType);
      formData.append('content', encryptedContent);
      if (msg.caption) formData.append('caption', msg.caption);
      await axios.post('https://gapp-6yc3.onrender.com/social/message', formData, { headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` } });
    } catch (err) {
      setError(`Failed to forward message: ${err.response?.data?.error || err.message}`);
      console.error('Forward message error:', err.response?.data || err);
    }
  };

  const addContact = async () => {
    if (!newContactNumber) return setError('Virtual number required');
    try {
      const { data } = await axios.post('https://gapp-6yc3.onrender.com/auth/add_contact', { userId, virtualNumber: newContactNumber }, { headers: { Authorization: `Bearer ${token}` } });
      setUsers((prev) => {
        const updatedUsers = prev.some((u) => u.id === data.id) ? prev : [...prev, data];
        localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
        return updatedUsers;
      });
      setNewContactNumber('');
      setMenuTab('');
      setError('');
    } catch (err) {
      const errMsg = err.response?.data?.error || err.message || 'Failed to add contact';
      setError(errMsg);
      console.error('Add contact error:', err.response?.data || err);
    }
  };

  const handleFileChange = (e, type) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setContentType(type);
      setMediaPreview({ type, url: URL.createObjectURL(selectedFile) });
      setShowPicker(false);
    }
  };

  const jumpToBottom = () => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
    setShowJumpToBottom(false);
    isAtBottomRef.current = true;
    setUnreadCount(0);
  };

  const handleLogout = () => {
    socket.emit('leave', userId);
    dispatch(resetState());
    localStorage.clear();
    setUsers([]);
    setNotifications({});
    setAuth('', '', '', '', '');
    setShowMenu(false);
  };


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
                  {(user.unreadCount || notifications[user.id]) > 0 && (
                    <span className="bg-green-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">{user.unreadCount || notifications[user.id]}</span>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
        <AnimatePresence>
          {showMenu && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
            >
              <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md">
                <div className="flex items-center mb-4">
                  <FaArrowLeft onClick={() => setShowMenu(false)} className="text-2xl text-primary dark:text-gray-100 cursor-pointer mr-4" />
                  <h2 className="text-xl font-bold text-primary dark:text-gray-100">Menu</h2>
                </div>
                <div className="space-y-2">
                  <motion.div onClick={() => setMenuTab('newNumber')} className={`flex items-center p-3 rounded-lg cursor-pointer ${menuTab === 'newNumber' ? 'bg-gray-200 dark:bg-gray-700' : ''}`} whileHover={{ backgroundColor: '#e5e7eb' }}>
                    <FaUserPlus className="text-primary dark:text-gray-100 mr-3" />
                    <span className="text-primary dark:text-gray-100">New Contact</span>
                  </motion.div>
                  <motion.div onClick={handleLogout} className="flex items-center p-3 rounded-lg cursor-pointer text-red-500" whileHover={{ backgroundColor: '#fee2e2' }}>
                    <FaSignOutAlt className="text-red-500 mr-3" />
                    <span>Logout</span>
                  </motion.div>
                </div>
                {menuTab === 'newNumber' && (
                  <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} className="mt-4">
                    <input
                      type="text"
                      value={newContactNumber}
                      onChange={(e) => setNewContactNumber(e.target.value)}
                      className="w-full p-2 mb-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                      placeholder="Enter virtual number (e.g., +12025550123)"
                    />
                    <button onClick={addContact} className="w-full bg-primary text-white p-2 rounded-lg hover:bg-secondary">Save Contact</button>
                    {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
                  </motion.div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className={`flex-1 flex flex-col ${isSmallDevice && !selectedChat ? 'hidden' : 'block'}`}>
        {selectedChat ? (
          <>
            <div className="bg-white dark:bg-gray-800 p-3 flex items-center border-b dark:border-gray-700 fixed top-0 md:left-[33.33%] md:w-2/3 left-0 right-0 z-10">
              {isSmallDevice && <FaArrowLeft onClick={() => dispatch(setSelectedChat(null))} className="text-xl text-primary dark:text-gray-100 cursor-pointer mr-3" />}
              <img src={users.find((u) => u.id === selectedChat)?.photo || 'https://placehold.co/40x40'} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
              <div>
                <span className="font-semibold dark:text-gray-100">{users.find((u) => u.id === selectedChat)?.username || 'Unknown'}</span>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  {isTyping[selectedChat] ? <span className="text-green-500">Typing...</span> : userStatus.status === 'online' ? <span className="text-green-500">Online</span> : formatLastSeen(userStatus.lastSeen)}
                </div>
              </div>
            </div>
            <div ref={chatRef} className="flex-1 overflow-y-auto bg-gray-100 dark:bg-gray-900 p-2 pt-16" style={{ paddingBottom: '80px' }}>
              {loading && <div className="text-center text-gray-500 dark:text-gray-400">Loading...</div>}
              {(chats[selectedChat] || []).map((msg, i) => {
                const showDateHeader = i === 0 || new Date(msg.createdAt).toDateString() !== new Date(chats[selectedChat][i - 1].createdAt).toDateString();
                return (
                  <motion.div key={msg._id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                    {showDateHeader && <div className="text-center my-2"><span className="bg-gray-300 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-1 rounded-full text-sm">{formatDateHeader(msg.createdAt)}</span></div>}
                    {firstUnreadMessageId === msg._id && unreadCount > 0 && <div className="text-center my-2"><span className="bg-blue-500 text-white px-2 py-1 rounded-full text-sm">{unreadCount} Unread</span></div>}
                    <div className={`flex ${msg.senderId === userId ? 'justify-end' : 'justify-start'} px-2 py-1`}>
                      <div
                        className={`max-w-[70%] p-2 rounded-lg shadow-sm ${msg.senderId === userId ? 'bg-green-500 text-white rounded-br-none' : 'bg-white dark:bg-gray-800 rounded-bl-none'}`}
                        onClick={() => ['image', 'video'].includes(msg.contentType) && setViewMedia({ type: msg.contentType, url: msg.content })}
                        onContextMenu={(e) => { e.preventDefault(); setShowMessageMenu(msg._id); }}
                      >
                        {msg.replyTo && <div className="bg-gray-100 dark:bg-gray-700 p-1 rounded mb-1 text-xs italic">{chats[selectedChat].find((m) => m._id === msg.replyTo)?.content.slice(0, 20)}...</div>}
                        {msg.contentType === 'text' && <p className="text-sm break-words">{msg.content}</p>}
                        {msg.contentType === 'image' && <img src={msg.content} alt="Chat" className="max-w-[80%] max-h-64 rounded-lg cursor-pointer" />}
                        {msg.contentType === 'video' && <video src={msg.content} className="max-w-[80%] max-h-64 rounded-lg" controls />}
                        {msg.contentType === 'audio' && <audio src={msg.content} controls className="max-w-[80%]" />}
                        {msg.contentType === 'document' && <div className="flex items-center"><FaFileAlt className="text-blue-600 mr-2" /><a href={msg.content} download className="text-blue-600 truncate">{msg.content.split('/').pop()}</a></div>}
                        {msg.caption && <p className="text-xs italic mt-1">{msg.caption}</p>}
                        <div className="flex justify-between mt-1">
                          {msg.senderId === userId && (
                            <span className="text-xs">
                              {msg.status === 'sending' ? '...' : msg.status === 'sent' ? '✔' : msg.status === 'delivered' ? '✔✔' : <span className="text-blue-300">✔✔</span>}
                            </span>
                          )}
                          <span className="text-xs text-gray-500">{formatTime(msg.createdAt)}</span>
                        </div>
                      </div>
                      <AnimatePresence>
                        {showMessageMenu === msg._id && (
                          <motion.div
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            className={`absolute ${msg.senderId === userId ? 'right-0' : 'left-0'} top-0 bg-white dark:bg-gray-800 p-2 rounded-lg shadow-lg z-20 flex space-x-2`}
                            onClick={() => setShowMessageMenu(null)}
                          >
                            <FaReply onClick={() => setReplyTo(msg)} className="text-primary dark:text-gray-100 cursor-pointer" />
                            <FaForward onClick={() => forwardMessage(msg)} className="text-primary dark:text-gray-100 cursor-pointer" />
                            {msg.senderId === userId && <FaTrash onClick={() => setShowDeleteConfirm(true)} className="text-red-500 cursor-pointer" />}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                );
              })}
            </div>
            <motion.div className="bg-white dark:bg-gray-800 p-2 border-t dark:border-gray-700 fixed md:left-[33.33%] md:w-2/3 left-0 right-0 bottom-0 z-30">
              {mediaPreview && (
                <div className="bg-gray-100 dark:bg-gray-700 p-2 mb-2 rounded relative">
                  {mediaPreview.type === 'image' && <img src={mediaPreview.url} alt="Preview" className="max-w-full max-h-64 rounded-lg" />}
                  {mediaPreview.type === 'video' && <video src={mediaPreview.url} className="max-w-full max-h-64 rounded-lg" controls />}
                  {mediaPreview.type === 'audio' && <audio src={mediaPreview.url} controls />}
                  {mediaPreview.type === 'document' && <div className="flex"><FaFileAlt className="text-blue-600 mr-2" /><span className="text-blue-600 truncate">{file.name}</span></div>}
                  <input type="text" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Add a caption..." className="w-full p-1 mt-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600" />
                  <button onClick={() => { setMediaPreview(null); setFile(null); }} className="absolute top-2 right-2 bg-red-500 text-white p-1 rounded-full"><FaTrash /></button>
                </div>
              )}
              {replyTo && (
                <div className="bg-gray-100 dark:bg-gray-700 p-2 mb-2 rounded flex justify-between">
                  <div><p className="text-xs italic">Replying to:</p><p className="text-sm">{replyTo.content.slice(0, 20)}...</p></div>
                  <button onClick={() => setReplyTo(null)} className="text-red-500"><FaTrash /></button>
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
                      className="absolute bottom-12 left-2 bg-white dark:bg-gray-800 p-2 rounded-lg shadow-lg z-20 flex space-x-2"
                    >
                      <label><FaFileAlt className="text-blue-600 cursor-pointer" /><input type="file" accept=".pdf" onChange={(e) => handleFileChange(e, 'document')} className="hidden" /></label>
                      <label><FaPlay className="text-green-500 cursor-pointer" /><input type="file" accept="audio/*" onChange={(e) => handleFileChange(e, 'audio')} className="hidden" /></label>
                      <label><img src="https://placehold.co/20x20" alt="Image" className="cursor-pointer" /><input type="file" accept="image/*" onChange={(e) => handleFileChange(e, 'image')} className="hidden" /></label>
                      <label><video width="20" height="20" className="cursor-pointer" /><input type="file" accept="video/*" onChange={(e) => handleFileChange(e, 'video')} className="hidden" /></label>
                    </motion.div>
                  )}
                </AnimatePresence>
                <input
                  type="text"
                  value={message}
                  onChange={handleTyping}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder="Type a message..."
                  className="flex-1 p-2 border rounded-lg mr-2 dark:bg-gray-700 dark:text-white dark:border-gray-600"
                  disabled={file || loading}
                />
                <FaPaperPlane onClick={sendMessage} className={`text-xl ${loading ? 'text-gray-400' : 'text-primary dark:text-gray-100'} cursor-pointer`} />
              </div>
              {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
            </motion.div>
            <AnimatePresence>
              {showJumpToBottom && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed bottom-20 md:left-[66%] left-1/2 transform -translate-x-1/2 bg-primary text-white p-2 rounded-full cursor-pointer z-40"
                  onClick={jumpToBottom}
                >
                  <FaArrowDown /> {unreadCount > 0 && `(${unreadCount})`}
                </motion.div>
              )}
              {showDeleteConfirm && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
                >
                  <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg">
                    <p className="mb-4 dark:text-gray-100">Delete this message?</p>
                    <div className="flex justify-end space-x-2">
                      <button onClick={() => setShowDeleteConfirm(false)} className="bg-gray-300 dark:bg-gray-600 text-black dark:text-white p-2 rounded-lg">Cancel</button>
                      <button onClick={deleteMessages} className="bg-red-500 text-white p-2 rounded-lg">Delete</button>
                    </div>
                  </div>
                </motion.div>
              )}
              {viewMedia && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50"
                  onClick={() => setViewMedia(null)}
                >
                  {viewMedia.type === 'image' && <img src={viewMedia.url} alt="Media" className="max-w-full max-h-full" />}
                  {viewMedia.type === 'video' && <video src={viewMedia.url} className="max-w-full max-h-full" controls autoPlay />}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center"><p className="text-gray-500 dark:text-gray-400">Select a chat to start messaging</p></div>
        )}
      </div>
    </motion.div>
  );
};

export default ChatScreen;