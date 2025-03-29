// ChatScreen.js (updated)
import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FaPaperPlane,
  FaPaperclip,
  FaTrash,
  FaArrowLeft,
  FaReply,
  FaEllipsisH,
  FaSave,
  FaShare,
  FaCopy,
  FaForward,
  FaFileAlt,
  FaPlay,
  FaArrowDown,
  FaDownload,
  FaUserPlus,
  FaSignOutAlt,
} from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import { setMessages, addMessage, updateMessageStatus, setSelectedChat, resetState } from '../store';
import { saveMessages, getMessages, clearOldMessages } from '../db';

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
  const [showPicker, setShowPicker] = useState(false);
  const [notifications, setNotifications] = useState(() => JSON.parse(localStorage.getItem('chatNotifications')) || {});
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [viewMedia, setViewMedia] = useState(null);
  const [typing, setTyping] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [menuTab, setMenuTab] = useState('');
  const [newContactNumber, setNewContactNumber] = useState('');
  const [newContactName, setNewContactName] = useState('');
  const [error, setError] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMessageMenu, setShowMessageMenu] = useState(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [mediaPreview, setMediaPreview] = useState(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [userStatus, setUserStatus] = useState({ status: 'offline', lastSeen: null });
  const [pendingMessages, setPendingMessages] = useState([]);
  const chatRef = useRef(null);
  const typingBoxRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isAtBottomRef = useRef(true);

  const messagesPerPage = 50;
  const isSmallDevice = window.innerWidth < 768;

  // Encryption Functions
  const encryptMessage = async (content, sharedKey) => {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const key = await window.crypto.subtle.importKey('raw', Uint8Array.from(atob(sharedKey), (c) => c.charCodeAt(0)), { name: 'AES-GCM' }, false, ['encrypt']);
    const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(content));
    return { encrypted: btoa(String.fromCharCode(...new Uint8Array(encrypted))), iv: btoa(String.fromCharCode(...iv)) };
  };

  const decryptMessage = async (encryptedContent, iv, sharedKey) => {
    const decoder = new TextDecoder();
    const key = await window.crypto.subtle.importKey('raw', Uint8Array.from(atob(sharedKey), (c) => c.charCodeAt(0)), { name: 'AES-GCM' }, false, ['decrypt']);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(atob(iv), (c) => c.charCodeAt(0)) },
      key,
      Uint8Array.from(atob(encryptedContent), (c) => c.charCodeAt(0))
    );
    return decoder.decode(decrypted);
  };

  const getSharedKey = async (recipientId) => {
    try {
      const response = await axios.get(`https://gapp-6yc3.onrender.com/auth/shared_key/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return response.data.sharedKey || null;
    } catch (error) {
      console.error('Error getting shared key:', error.message);
      return null;
    }
  };

  // Date and Time Formatting (unchanged)
  const formatChatListDate = (date) => {
    const messageDate = new Date(date);
    const now = new Date();
    const diffTime = now - messageDate;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return messageDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    else if (diffDays === 1) return 'Yesterday';
    else return messageDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
  };

  const formatDateHeader = (date) => {
    const today = new Date();
    const messageDate = new Date(date);
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const messageDateOnly = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
    const diffTime = todayDate - messageDateOnly;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'Today';
    else if (diffDays === 1) return 'Yesterday';
    else return messageDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const formatTime = (date) => {
    return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  const formatLastSeen = (lastSeen) => {
    if (!lastSeen) return '';
    const date = new Date(lastSeen);
    return `Last seen ${date.toLocaleDateString()} at ${formatTime(date)}`;
  };

  useEffect(() => {
    if (!userId || !token) return;

    socket.emit('join', userId);

    const keepAlive = setInterval(() => {
      socket.emit('ping', { userId });
    }, 30000);

    clearOldMessages(30).catch((error) => console.error('Error clearing old messages:', error));

    const fetchUsers = async () => {
      try {
        const cachedUsers = JSON.parse(localStorage.getItem('cachedUsers')) || [];
        if (cachedUsers.length > 0) setUsers(cachedUsers);
        const { data } = await axios.get('https://gapp-6yc3.onrender.com/auth/contacts', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const usersWithLatestMessage = await Promise.all(
          data.map(async (user) => {
            const { data: messagesData } = await axios.get('https://gapp-6yc3.onrender.com/social/messages', {
              headers: { Authorization: `Bearer ${token}` },
              params: { userId, recipientId: user.id, limit: 1, skip: 0 },
            });
            const latestMessage = messagesData.messages[0] || null;
            const unreadCount = latestMessage && latestMessage.recipientId === userId && latestMessage.status !== 'read' ? 1 : 0;
            return { ...user, latestMessage, unreadCount, status: 'offline', lastSeen: null };
          })
        );
        usersWithLatestMessage.sort((a, b) => {
          const dateA = a.latestMessage ? new Date(a.latestMessage.createdAt) : new Date(0);
          const dateB = b.latestMessage ? new Date(b.latestMessage.createdAt) : new Date(0);
          return dateB - dateA;
        });
        setUsers(usersWithLatestMessage);
        localStorage.setItem('cachedUsers', JSON.stringify(usersWithLatestMessage));
      } catch (error) {
        console.error('Fetch users error:', error);
        setError('Failed to load contacts');
      }
    };
    fetchUsers();

    const fetchMessages = async (pageNum = 0, isInitialLoad = true) => {
      if (!selectedChat || loading) return;
      setLoading(true);
      try {
        const { data } = await axios.get('https://gapp-6yc3.onrender.com/social/messages', {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId: selectedChat, limit: messagesPerPage, skip: pageNum * messagesPerPage },
        });
        const sharedKey = await getSharedKey(selectedChat);
        const messages = await Promise.all(
          data.messages.map(async (msg) => ({
            ...msg,
            content: msg.contentType === 'text' && sharedKey && msg.iv ? await decryptMessage(msg.content, msg.iv, sharedKey) : msg.content,
          }))
        );
        setHasMore(data.hasMore);

        if (isInitialLoad) {
          dispatch(setMessages({ recipientId: selectedChat, messages }));
          const unreadMessages = messages.filter((msg) => msg.recipientId === userId && msg.status !== 'read');
          setUnreadCount(unreadMessages.length);
          if (unreadMessages.length > 0) setFirstUnreadMessageId(unreadMessages[0]._id);
          chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'auto' });
        } else {
          dispatch(setMessages({ recipientId: selectedChat, messages: [...messages, ...(chats[selectedChat] || [])] }));
        }
        await saveMessages(messages);
      } catch (error) {
        console.error('Fetch messages error:', error);
        if (isInitialLoad) setError('Failed to load messages');
      } finally {
        setLoading(false);
      }
    };

    if (selectedChat) {
      setPage(0);
      setHasMore(true);
      fetchMessages(0, true);

      const fetchUserStatus = async () => {
        try {
          const { data } = await axios.get(`https://gapp-6yc3.onrender.com/social/user-status/${selectedChat}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          setUserStatus(data);
        } catch (error) {
          console.error('Fetch user status error:', error);
        }
      };
      fetchUserStatus();
    }

    socket.on('message', async (msg) => {
      const chatId = msg.senderId === userId ? msg.recipientId : msg.senderId;
      const sharedKey = await getSharedKey(chatId);
      const content = msg.contentType === 'text' && sharedKey && msg.iv ? await decryptMessage(msg.content, msg.iv, sharedKey) : msg.content;
      const updatedMsg = { ...msg, content };

      dispatch(addMessage({ recipientId: chatId, message: updatedMsg }));
      await saveMessages([updatedMsg]);

      if (msg.recipientId === userId && !users.some((u) => u.id === msg.senderId)) {
        setUsers((prev) => {
          const updatedUsers = [
            ...prev,
            { id: msg.senderId, virtualNumber: msg.senderVirtualNumber, username: msg.senderUsername || 'Unsaved Number', photo: msg.senderPhoto || 'https://placehold.co/40x40', unreadCount: 0 },
          ];
          localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
          return updatedUsers;
        });
      }

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
        } else if (isAtBottomRef.current) {
          chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
        } else {
          setShowJumpToBottom(true);
        }
      } else if (msg.recipientId === userId) {
        setNotifications((prev) => {
          const updated = { ...prev, [msg.senderId]: (prev[msg.senderId] || 0) + 1 };
          localStorage.setItem('chatNotifications', JSON.stringify(updated));
          return updated;
        });
        setUsers((prev) => {
          const updatedUsers = prev.map((user) =>
            user.id === msg.senderId ? { ...user, latestMessage: updatedMsg, unreadCount: (user.unreadCount || 0) + 1 } : user
          ).sort((a, b) => (b.latestMessage?.createdAt || 0) - (a.latestMessage?.createdAt || 0));
          localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
          return updatedUsers;
        });
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
      if (status === 'read' && selectedChat) {
        setUnreadCount(0);
        setFirstUnreadMessageId(null);
      }
    });

    socket.on('onlineStatus', ({ userId: contactId, status, lastSeen }) => {
      setUsers((prev) => prev.map((user) => (user.id === contactId ? { ...user, status, lastSeen } : user)));
      if (contactId === selectedChat) setUserStatus({ status, lastSeen });
    });

    const handleScroll = () => {
      if (chatRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
        isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
        setShowJumpToBottom(!isAtBottomRef.current);

        if (scrollTop < 50 && hasMore && !loading) setPage((prev) => prev + 1);

        if (isAtBottomRef.current && selectedChat) {
          const unreadMessages = (chats[selectedChat] || []).filter((msg) => msg.recipientId === userId && msg.status !== 'read');
          unreadMessages.forEach((msg) => socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId }));
          setUnreadCount(0);
          setFirstUnreadMessageId(null);
        }
      }
    };
    chatRef.current?.addEventListener('scroll', handleScroll);

    if (page > 0) fetchMessages(page, false);

    const handleOnline = async () => {
      if (pendingMessages.length > 0) {
        for (const msg of pendingMessages) await sendMessageToServer(msg);
        setPendingMessages([]);
      }
    };
    window.addEventListener('online', handleOnline);

    return () => {
      socket.off('message');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
      socket.off('onlineStatus');
      chatRef.current?.removeEventListener('scroll', handleScroll);
      window.removeEventListener('online', handleOnline);
      clearInterval(keepAlive);
    };
  }, [token, userId, selectedChat, page, dispatch]);

  const sendMessageToServer = async (msgData) => {
    const formData = new FormData();
    formData.append('senderId', msgData.senderId);
    formData.append('recipientId', msgData.recipientId);
    formData.append('contentType', msgData.contentType);
    formData.append('caption', msgData.caption || '');
    if (msgData.contentType === 'text' && msgData.iv) formData.append('iv', msgData.iv);
    if (msgData.file) formData.append('content', msgData.file);
    else formData.append('content', msgData.content);
    if (msgData.replyTo) formData.append('replyTo', msgData.replyTo);

    try {
      if (msgData.file) setUploadProgress(0);
      const { data } = await axios.post('https://gapp-6yc3.onrender.com/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
        onUploadProgress: (progressEvent) => {
          if (msgData.file) setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total));
        },
      });
      dispatch(
        setMessages({
          recipientId: selectedChat,
          messages: (chats[selectedChat] || []).map((msg) =>
            msg._id === msgData.tempId ? { ...data, content: msg.content } : msg
          ),
        })
      );
      await saveMessages([data]);
      setUploadProgress(null);
    } catch (error) {
      console.error('Send message error:', error);
      setUploadProgress(null);
      setError('Failed to send message');
    }
  };

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
      replyTo: replyTo?._id || null,
      createdAt: new Date(),
    };

    dispatch(addMessage({ recipientId: selectedChat, message: tempMsg }));
    if (isAtBottomRef.current) chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });

    let encryptedContent = message;
    let iv = '';
    if (contentType === 'text') {
      const sharedKey = await getSharedKey(selectedChat);
      if (sharedKey) {
        const { encrypted, iv: encryptionIv } = await encryptMessage(message, sharedKey);
        encryptedContent = encrypted;
        iv = encryptionIv;
      }
    }

    const messageForServer = { ...tempMsg, content: encryptedContent, iv, file, tempId };
    await saveMessages([{ ...messageForServer, content: message }]);

    setMessage('');
    setFile(null);
    setCaption('');
    setContentType('text');
    setShowPicker(false);
    setReplyTo(null);
    setMediaPreview(null);

    if (navigator.onLine) {
      await sendMessageToServer(messageForServer);
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: tempId, status: 'sent' }));
    } else {
      setPendingMessages((prev) => [...prev, messageForServer]);
      dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: tempId, status: 'pending' }));
    }

    setUsers((prev) => {
      const updatedUsers = prev.map((user) =>
        user.id === selectedChat ? { ...user, latestMessage: { ...tempMsg, content: message } } : user
      ).sort((a, b) => (b.latestMessage?.createdAt || 0) - (a.latestMessage?.createdAt || 0));
      localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
      return updatedUsers;
    });
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
    if (selectedMessages.length === 0) return;
    try {
      await Promise.all(
        selectedMessages.map((messageId) =>
          axios.delete(`https://gapp-6yc3.onrender.com/social/message/${messageId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        )
      );
      dispatch(
        setMessages({
          recipientId: selectedChat,
          messages: (chats[selectedChat] || []).filter((msg) => !selectedMessages.includes(msg._id)),
        })
      );
      await saveMessages((chats[selectedChat] || []).filter((msg) => !selectedMessages.includes(msg._id)));
      setSelectedMessages([]);
      setShowDeleteConfirm(false);
    } catch (error) {
      console.error('Delete message error:', error);
      setError('Failed to delete messages');
    }
  };

  const viewMessage = (msg) => {
    if (msg.senderId !== userId && msg.status !== 'read') {
      socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
    }
    setViewMedia({ type: msg.contentType, url: msg.content });
  };

  const forwardMessage = async (msg) => {
    const recipientVirtualNumber = prompt('Enter the virtual number of the user to forward to:');
    if (!recipientVirtualNumber) return;
    const contact = users.find((u) => u.virtualNumber === recipientVirtualNumber);
    if (!contact) {
      setError('User not found');
      return;
    }

    const sharedKey = await getSharedKey(contact.id);
    const { encrypted, iv } = msg.contentType === 'text' && sharedKey ? await encryptMessage(msg.content, sharedKey) : { encrypted: msg.content, iv: msg.iv || '' };
    const formData = new FormData();
    formData.append('senderId', userId);
    formData.append('recipientId', contact.id);
    formData.append('contentType', msg.contentType);
    formData.append('caption', msg.caption || '');
    formData.append('content', encrypted);
    if (msg.contentType === 'text' && sharedKey) formData.append('iv', iv);

    try {
      const { data } = await axios.post('https://gapp-6yc3.onrender.com/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      dispatch(addMessage({ recipientId: contact.id, message: data }));
    } catch (error) {
      setError('Failed to forward message');
    }
  };

  const copyMessage = (msg) => {
    if (msg.contentType === 'text') {
      navigator.clipboard.writeText(msg.content);
      alert('Message copied to clipboard');
    }
  };

  const shareMessage = (msg) => {
    if (navigator.share) {
      navigator.share({
        title: 'Shared Message',
        text: msg.contentType === 'text' ? msg.content : undefined,
        url: msg.contentType !== 'text' ? msg.content : undefined,
      });
    }
  };
  const addContact = async () => {
    if (!newContactNumber) {
      setError('Virtual number is required');
      return;
    }
    if (!/^\+\d{10,15}$/.test(newContactNumber)) {
      setError('Invalid virtual number format (e.g., +12025550123)');
      return;
    }
    try {
      const { data } = await axios.post(
        'https://gapp-6yc3.onrender.com/auth/add_contact',
        { userId, virtualNumber: newContactNumber },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const newContact = {
        id: data.userId,
        virtualNumber: data.virtualNumber,
        username: newContactName || data.username || data.virtualNumber,
        photo: data.photo || 'https://placehold.co/40x40',
        unreadCount: 0,
        latestMessage: null,
        status: 'offline',
        lastSeen: null,
      };
      setUsers((prev) => {
        const updatedUsers = [...prev, newContact].sort((a, b) => (b.latestMessage?.createdAt || 0) - (a.latestMessage?.createdAt || 0));
        localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
        return updatedUsers;
      });
      setNewContactNumber('');
      setNewContactName('');
      setMenuTab('');
      setError('');
      dispatch(setSelectedChat(data.userId));
    } catch (error) {
      console.error('Add contact error:', error);
      setError(error.response?.data?.details || error.response?.data?.error || 'Failed to add contact');
    }
  };

  const handleFileChange = (e, type) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setContentType(type);
      setMediaPreview({ type, url: URL.createObjectURL(selectedFile), name: selectedFile.name });
      setShowPicker(false);
    }
  };

  const jumpToBottom = () => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
    setShowJumpToBottom(false);
    isAtBottomRef.current = true;
    setUnreadCount(0);
    setFirstUnreadMessageId(null);
    const unreadMessages = (chats[selectedChat] || []).filter((msg) => msg.recipientId === userId && msg.status !== 'read');
    unreadMessages.forEach((msg) => socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId }));
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

  // Animation variants for typing box
  const typingBoxVariants = {
    hidden: { y: 100, opacity: 0 },
    visible: { y: 0, opacity: 1, transition: { type: 'spring', stiffness: 300, damping: 20 } },
    expanded: { y: 0, opacity: 1, transition: { type: 'spring', stiffness: 300, damping: 20 } },
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className="flex h-screen bg-gray-100">
      <div className={`w-full md:w-1/3 bg-white border-r border-gray-200 flex flex-col ${isSmallDevice && selectedChat ? 'hidden' : 'block'}`}>
        <div className="p-4 flex justify-between items-center border-b border-gray-200">
          <h2 className="text-xl font-bold text-primary">Chats</h2>
          <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
            <FaEllipsisH onClick={() => setShowMenu(true)} className="text-2xl text-primary cursor-pointer hover:text-secondary" />
          </motion.div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {users.map((user) => (
            <motion.div
              key={user.id}
              whileHover={{ backgroundColor: '#f0f0f0' }}
              onClick={() => dispatch(setSelectedChat(user.id))}
              className={`flex items-center p-3 border-b border-gray-200 cursor-pointer ${selectedChat === user.id ? 'bg-gray-100' : ''}`}
            >
              <div className="relative">
                <img src={user.photo || 'https://placehold.co/40x40'} alt="Profile" className="w-12 h-12 rounded-full mr-3" />
                {user.status === 'online' && (
                  <span className="absolute bottom-0 right-3 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></span>
                )}
              </div>
              <div className="flex-1">
                <div className="flex justify-between">
                  <span className="font-semibold">{user.username || user.virtualNumber}</span>
                  {user.latestMessage && (
                    <span className="text-xs text-gray-500">{formatChatListDate(user.latestMessage.createdAt)}</span>
                  )}
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600 truncate max-w-[70%]">
                    {user.latestMessage ? user.latestMessage.content : 'No messages yet'}
                  </span>
                  {(user.unreadCount || notifications[user.id]) > 0 && (
                    <span className="ml-2 bg-green-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                      {user.unreadCount || notifications[user.id]}
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
        {showMenu && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          >
            <div className="bg-white p-6 rounded-lg shadow-lg w-full max-w-md">
              <div className="flex items-center mb-4">
                <FaArrowLeft onClick={() => setShowMenu(false)} className="text-2xl text-primary cursor-pointer hover:text-secondary mr-4" />
                <h2 className="text-xl font-bold text-primary">Menu</h2>
              </div>
              <div className="space-y-2">
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  onClick={() => setMenuTab('newNumber')}
                  className={`flex items-center p-3 rounded-lg cursor-pointer ${menuTab === 'newNumber' ? 'bg-gray-200' : ''}`}
                >
                  <FaUserPlus className="text-primary mr-3" />
                  <span className="text-primary">New Number</span>
                </motion.div>
                <motion.div whileHover={{ scale: 1.05 }} className="flex items-center p-3 rounded-lg cursor-pointer text-red-500" onClick={handleLogout}>
                  <FaSignOutAlt className="text-red-500 mr-3" />
                  <span>Logout</span>
                </motion.div>
              </div>
              {menuTab === 'newNumber' && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
                  <input
                    type="text"
                    value={newContactNumber}
                    onChange={(e) => setNewContactNumber(e.target.value)}
                    className="w-full p-2 mb-2 border rounded-lg"
                    placeholder="Enter virtual number (e.g., +12025550123)"
                  />
                  <input
                    type="text"
                    value={newContactName}
                    onChange={(e) => setNewContactName(e.target.value)}
                    className="w-full p-2 mb-2 border rounded-lg"
                    placeholder="Enter contact name (optional)"
                  />
                  <button onClick={addContact} className="w-full bg-primary text-white p-2 rounded-lg hover:bg-secondary">
                    Save Contact
                  </button>
                  {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </div>

      <div className={`flex-1 flex flex-col ${isSmallDevice && !selectedChat ? 'hidden' : 'block'}`}>
        {selectedChat ? (
          <>
            <div className="bg-white p-3 flex items-center border-b border-gray-200 fixed top-0 md:left-[33.33%] md:w-2/3 left-0 right-0 z-10">
              {isSmallDevice && (
                <FaArrowLeft
                  onClick={() => dispatch(setSelectedChat(null))}
                  className="text-xl text-primary cursor-pointer mr-3 hover:text-secondary"
                />
              )}
              <img
                src={users.find((u) => u.id === selectedChat)?.photo || 'https://placehold.co/40x40'}
                alt="Profile"
                className="w-10 h-10 rounded-full mr-2"
              />
              <div>
                <span className="font-semibold">{users.find((u) => u.id === selectedChat)?.username || 'Unknown'}</span>
                <div className="text-sm text-gray-500">
                  {isTyping[selectedChat] ? (
                    <span className="text-green-500">Typing...</span>
                  ) : userStatus.status === 'online' ? (
                    <span className="text-green-500">Online</span>
                  ) : (
                    <span>{formatLastSeen(userStatus.lastSeen)}</span>
                  )}
                </div>
              </div>
            </div>
            <div
              ref={chatRef}
              className="flex-1 overflow-y-auto bg-gray-100 p-2 pt-16"
              style={{ paddingBottom: typingBoxRef.current ? `${typingBoxRef.current.offsetHeight}px` : '80px' }}
            >
              {(chats[selectedChat] || []).length === 0 ? (
                <p className="text-center text-gray-500 mt-4">No messages yet</p>
              ) : (
                <>
                  {(chats[selectedChat] || []).map((msg, index) => {
                    const currentDate = new Date(msg.createdAt);
                    const prevMsg = index > 0 ? chats[selectedChat][index - 1] : null;
                    const showDateHeader = !prevMsg || currentDate.toDateString() !== new Date(prevMsg.createdAt).toDateString();

                    return (
                      <motion.div key={msg._id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                        {showDateHeader && (
                          <div className="text-center my-2">
                            <span className="bg-gray-300 text-gray-700 px-2 py-1 rounded-full text-sm">{formatDateHeader(msg.createdAt)}</span>
                          </div>
                        )}
                        {firstUnreadMessageId === msg._id && unreadCount > 0 && (
                          <div className="text-center my-2">
                            <span className="bg-blue-500 text-white px-2 py-1 rounded-full text-sm">{unreadCount} Unread Messages</span>
                          </div>
                        )}
                        <div
                          className={`flex ${msg.senderId === userId ? 'justify-end' : 'justify-start'} px-2 py-1`}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setShowMessageMenu(msg._id);
                          }}
                        >
                          <div
                            className={`max-w-[70%] p-2 rounded-lg shadow-sm ${
                              msg.senderId === userId ? 'bg-green-500 text-white rounded-br-none' : 'bg-white text-black rounded-bl-none'
                            } ${selectedMessages.includes(msg._id) ? 'bg-opacity-50' : ''}`}
                            onClick={() => {
                              if (selectedMessages.length > 0) {
                                setSelectedMessages((prev) =>
                                  prev.includes(msg._id) ? prev.filter((id) => id !== msg._id) : [...prev, msg._id]
                                );
                              } else if (msg.contentType === 'video' || msg.contentType === 'image') {
                                viewMessage(msg);
                              }
                            }}
                          >
                            {msg.replyTo && chats[selectedChat]?.find((m) => m._id === msg.replyTo) && (
                              <div
                                className="bg-gray-100 p-1 rounded mb-1 text-xs italic text-gray-700 border-l-4 border-green-500 cursor-pointer"
                                onClick={() => chatRef.current.scrollTo({ top: document.getElementById(`message-${msg.replyTo}`).offsetTop - 50, behavior: 'smooth' })}
                              >
                                <p>{chats[selectedChat].find((m) => m._id === msg.replyTo).content.slice(0, 20) + '...'}</p>
                              </div>
                            )}
                            {msg.contentType === 'text' && <p className="text-sm break-words">{msg.content}</p>}
                            {msg.contentType === 'image' && (
                              <img src={msg.content} alt="Chat" className="max-w-[80%] max-h-64 object-contain rounded-lg" />
                            )}
                            {msg.contentType === 'video' && (
                              <video src={msg.content} className="max-w-[80%] max-h-64 object-contain rounded-lg" controls />
                            )}
                            {msg.contentType === 'audio' && <audio src={msg.content} controls className="max-w-[80%] h-10" />}
                            {msg.contentType === 'document' && (
                              <div className="flex items-center bg-gray-100 p-2 rounded-lg">
                                <FaFileAlt className="text-blue-600 mr-2" />
                                <span className="text-blue-600 truncate max-w-[200px]">{msg.content.split('/').pop()}</span>
                                <a href={msg.content} download className="ml-2 text-blue-600">
                                  <FaDownload />
                                </a>
                              </div>
                            )}
                            {msg.caption && <p className="text-xs italic mt-1">{msg.caption}</p>}
                            <div className="flex justify-between items-center mt-1">
                              {msg.senderId === userId && (
                                <span className="text-xs">
                                  {msg.status === 'pending' && '🕒'}
                                  {msg.status === 'sent' && '✔'}
                                  {msg.status === 'delivered' && '✔✔'}
                                  {msg.status === 'read' && <span className="text-blue-300">✔✔</span>}
                                </span>
                              )}
                              <span className="text-xs text-gray-500">{formatTime(msg.createdAt)}</span>
                            </div>
                          </div>
                          {showMessageMenu === msg._id && (
                            <motion.div
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{ opacity: 1, scale: 1 }}
                              className={`absolute ${msg.senderId === userId ? 'right-0' : 'left-0'} top-0 bg-white p-2 rounded-lg shadow-lg z-20 flex space-x-2`}
                              onClick={() => setShowMessageMenu(null)}
                            >
                              <FaReply onClick={() => setReplyTo(msg)} className="text-primary cursor-pointer" />
                              <FaForward onClick={() => forwardMessage(msg)} className="text-primary cursor-pointer" />
                              <FaCopy onClick={() => copyMessage(msg)} className="text-primary cursor-pointer" />
                              <FaShare onClick={() => shareMessage(msg)} className="text-primary cursor-pointer" />
                              {msg.senderId === userId && (
                                <FaTrash
                                  onClick={() => {
                                    setSelectedMessages([msg._id]);
                                    setShowDeleteConfirm(true);
                                  }}
                                  className="text-red-500 cursor-pointer"
                                />
                              )}
                            </motion.div>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                  {loading && page > 0 && <div className="text-center py-2">Loading more...</div>}
                </>
              )}
            </div>
            <motion.div
              ref={typingBoxRef}
              variants={typingBoxVariants}
              initial="hidden"
              animate={mediaPreview || replyTo ? 'expanded' : 'visible'}
              className="bg-white p-2 border-t border-gray-200 fixed md:left-[33.33%] md:w-2/3 left-0 right-0 z-30 shadow-lg rounded-t-lg"
              style={{ bottom: '0px' }}
            >
              {mediaPreview && (
                <div className="bg-gray-100 p-2 mb-2 rounded w-full max-w-[80%] mx-auto">
                  {mediaPreview.type === 'image' && <img src={mediaPreview.url} alt="Preview" className="max-w-full max-h-64 object-contain rounded-lg" />}
                  {mediaPreview.type === 'video' && <video src={mediaPreview.url} className="max-w-full max-h-64 object-contain rounded-lg" controls />}
                  {mediaPreview.type === 'audio' && <audio src={mediaPreview.url} controls className="w-full" />}
                  {mediaPreview.type === 'document' && (
                    <div className="flex items-center">
                      <FaFileAlt className="text-blue-600 mr-2" />
                      <span className="text-blue-600 truncate max-w-[200px]">{mediaPreview.name}</span>
                    </div>
                  )}
                  <input
                    type="text"
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    placeholder="Add a caption..."
                    className="w-full p-1 mt-2 border rounded-lg text-sm"
                  />
                  <button onClick={() => setMediaPreview(null)} className="absolute top-2 right-2 bg-red-500 text-white p-1 rounded-full">
                    <FaTrash />
                  </button>
                </div>
              )}
              {replyTo && (
                <div className="bg-gray-100 p-2 mb-2 rounded w-full max-w-[80%] mx-auto flex justify-between items-center">
                  <div>
                    <p className="text-xs italic text-gray-700">Replying to:</p>
                    <p className="text-sm">{replyTo.content.slice(0, 20) + '...'}</p>
                  </div>
                  <button onClick={() => setReplyTo(null)} className="text-red-500">
                    <FaTrash />
                  </button>
                </div>
              )}
              <div className="flex items-center">
                <FaPaperclip onClick={() => setShowPicker(!showPicker)} className="text-xl text-primary cursor-pointer mr-2" />
                {showPicker && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute bottom-12 left-2 bg-white p-2 rounded-lg shadow-lg z-20 flex space-x-2"
                  >
                    <label><FaFileAlt className="text-blue-600" /><input type="file" accept=".pdf" onChange={(e) => handleFileChange(e, 'document')} className="hidden" /></label>
                    <label><FaPlay className="text-green-500" /><input type="file" accept="audio/*" onChange={(e) => handleFileChange(e, 'audio')} className="hidden" /></label>
                    <label><img src="https://placehold.co/20x20" alt="Image" /><input type="file" accept="image/*" onChange={(e) => handleFileChange(e, 'image')} className="hidden" /></label>
                    <label><video width="20" height="20" /><input type="file" accept="video/*" onChange={(e) => handleFileChange(e, 'video')} className="hidden" /></label>
                  </motion.div>
                )}
                <input
                  type="text"
                  value={message}
                  onChange={handleTyping}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder="Type a message..."
                  className="flex-1 p-2 border rounded-lg mr-2 focus:outline-none focus:ring-2 focus:ring-primary"
                  disabled={file}
                />
                <FaPaperPlane onClick={sendMessage} className="text-xl text-primary cursor-pointer hover:text-secondary" />
              </div>
              {uploadProgress !== null && (
                <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                  <div className="bg-primary h-2 rounded-full" style={{ width: `${uploadProgress}%` }}></div>
                </div>
              )}
              {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
            </motion.div>
            {showJumpToBottom && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="fixed bottom-20 md:left-[66%] left-1/2 transform -translate-x-1/2 bg-primary text-white p-2 rounded-full cursor-pointer z-40"
                onClick={jumpToBottom}
              >
                <FaArrowDown /> {unreadCount > 0 && `(${unreadCount})`}
              </motion.div>
            )}
            {showDeleteConfirm && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div className="bg-white p-6 rounded-lg shadow-lg">
                  <p className="mb-4">Delete {selectedMessages.length} message(s)?</p>
                  <div className="flex justify-end space-x-2">
                    <button onClick={() => setShowDeleteConfirm(false)} className="bg-gray-300 text-black p-2 rounded-lg">Cancel</button>
                    <button onClick={deleteMessages} className="bg-red-500 text-white p-2 rounded-lg">Delete</button>
                  </div>
                </div>
              </motion.div>
            )}
            {viewMedia && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50"
                onClick={() => setViewMedia(null)}
              >
                {viewMedia.type === 'image' && <img src={viewMedia.url} alt="Media" className="max-w-full max-h-full" />}
                {viewMedia.type === 'video' && <video src={viewMedia.url} controls className="max-w-full max-h-full" />}
                {viewMedia.type === 'audio' && <audio src={viewMedia.url} controls className="w-full max-w-md" />}
                {viewMedia.type === 'document' && (
                  <div className="bg-white p-4 rounded-lg">
                    <a href={viewMedia.url} download className="text-blue-600">Download Document</a>
                  </div>
                )}
              </motion.div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-gray-500">Select a chat to start messaging</p>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default ChatScreen;