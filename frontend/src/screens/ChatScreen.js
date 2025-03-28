
// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply, FaEllipsisH, FaSave, FaShare, FaCopy, FaForward, FaFileAlt, FaPlay, FaArrowDown, FaDownload, FaUserPlus, FaUsers, FaPaintBrush, FaCog, FaSignOutAlt } from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import { setMessages, addMessage, updateMessageStatus, setSelectedChat, resetState } from '../store';
import { saveMessages, getMessages } from '../db';

const socket = io('https://gapp-6yc3.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
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
  const [holdTimer, setHoldTimer] = useState(null);
  const [swipeStartX, setSwipeStartX] = useState(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [userStatus, setUserStatus] = useState({ status: 'offline', lastSeen: null });
  const [pendingMessages, setPendingMessages] = useState([]);
  const chatRef = useRef(null);
  const menuRef = useRef(null);
  const messageMenuRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isAtBottomRef = useRef(true);

  const messagesPerPage = 50;
  const isSmallDevice = window.innerWidth < 768;

  // Diffie-Hellman Key Exchange and AES Encryption Functions
  const generateDHKeyPair = async () => {
    const dh = await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
    const publicKey = await window.crypto.subtle.exportKey('raw', dh.publicKey);
    const privateKey = await window.crypto.subtle.exportKey('raw', dh.privateKey);
    const publicKeyBase64 = Buffer.from(publicKey).toString('base64');
    const privateKeyBase64 = Buffer.from(privateKey).toString('base64');

    // Store private key locally (insecure for production; use a secure store)
    localStorage.setItem(`privateKey_${userId}`, privateKeyBase64);

    return { publicKey: publicKeyBase64 };
  };

  const deriveSharedKey = async (recipientPublicKey) => {
    const privateKeyBase64 = localStorage.getItem(`privateKey_${userId}`);
    if (!privateKeyBase64) throw new Error('Private key not found');

    const privateKeyObj = await window.crypto.subtle.importKey(
      'raw',
      Buffer.from(privateKeyBase64, 'base64'),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey']
    );
    const publicKeyObj = await window.crypto.subtle.importKey(
      'raw',
      Buffer.from(recipientPublicKey, 'base64'),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const sharedKey = await window.crypto.subtle.deriveKey(
      { name: 'ECDH', public: publicKeyObj },
      privateKeyObj,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    return sharedKey;
  };

  const encryptMessage = async (content, sharedKey) => {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sharedKey,
      encoder.encode(content)
    );
    return { encrypted: Buffer.from(encrypted).toString('base64'), iv: Buffer.from(iv).toString('base64') };
  };

  const decryptMessage = async (encryptedContent, iv, sharedKey) => {
    const decoder = new TextDecoder();
    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(iv, 'base64') },
      sharedKey,
      Buffer.from(encryptedContent, 'base64')
    );
    return decoder.decode(decrypted);
  };

  const getSharedKey = async (recipientId) => {
    const response = await axios.get(`/auth/shared_key/${recipientId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return await deriveSharedKey(response.data.recipientPublicKey);
  };

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
    return `Last seen at ${formatTime(date)}`;
  };

  useEffect(() => {
    if (!userId || !token) return;

    socket.emit('join', userId);

    const keepAlive = setInterval(() => {
      socket.emit('ping', { userId });
    }, 30000); // Reduced to 30 seconds for more frequent status updates

    const fetchUsers = async () => {
      try {
        const cachedUsers = JSON.parse(localStorage.getItem('cachedUsers'));
        if (cachedUsers && cachedUsers.length > 0) {
          setUsers(cachedUsers);
          const usersWithLatestMessage = await Promise.all(
            cachedUsers.map(async (user) => {
              try {
                const { data } = await axios.get('/social/messages', {
                  headers: { Authorization: `Bearer ${token}` },
                  params: { userId, recipientId: user.id, limit: 1, skip: 0 },
                });
                const latestMessage = data.messages.length > 0 ? data.messages[0] : null;
                const unreadCount = latestMessage && latestMessage.recipientId === userId && latestMessage.status !== 'read' ? 1 : 0;
                return { ...user, latestMessage, unreadCount };
              } catch (error) {
                console.error(`Error fetching latest message for user ${user.id}:`, error);
                return { ...user, latestMessage: null, unreadCount: 0 };
              }
            })
          );
          usersWithLatestMessage.sort((a, b) => {
            const dateA = a.latestMessage ? new Date(a.latestMessage.createdAt) : new Date(0);
            const dateB = b.latestMessage ? new Date(b.latestMessage.createdAt) : new Date(0);
            return dateB - dateA;
          });
          setUsers(usersWithLatestMessage);
          localStorage.setItem('cachedUsers', JSON.stringify(usersWithLatestMessage));
        } else {
          const { data } = await axios.get('/auth/contacts', {
            headers: { Authorization: `Bearer ${token}` },
          });
          const usersWithLatestMessage = await Promise.all(
            data.map(async (user) => {
              try {
                const { data: messagesData } = await axios.get('/social/messages', {
                  headers: { Authorization: `Bearer ${token}` },
                  params: { userId, recipientId: user.id, limit: 1, skip: 0 },
                });
                const latestMessage = messagesData.messages.length > 0 ? messagesData.messages[0] : null;
                const unreadCount = latestMessage && latestMessage.recipientId === userId && latestMessage.status !== 'read' ? 1 : 0;
                return { ...user, latestMessage, unreadCount };
              } catch (error) {
                console.error(`Error fetching latest message for user ${user.id}:`, error);
                return { ...user, latestMessage: null, unreadCount: 0 };
              }
            })
          );
          usersWithLatestMessage.sort((a, b) => {
            const dateA = a.latestMessage ? new Date(a.latestMessage.createdAt) : new Date(0);
            const dateB = b.latestMessage ? new Date(b.latestMessage.createdAt) : new Date(0);
            return dateB - dateA;
          });
          setUsers(usersWithLatestMessage);
          localStorage.setItem('cachedUsers', JSON.stringify(usersWithLatestMessage));
        }
      } catch (error) {
        setError('Failed to load contacts');
      }
    };
    fetchUsers();

    const loadOfflineMessages = async () => {
      const offlineMessages = await getMessages();
      if (offlineMessages.length > 0) {
        for (const msg of offlineMessages) {
          const sharedKey = await getSharedKey(msg.recipientId === userId ? msg.senderId : msg.recipientId);
          const decryptedContent = msg.contentType === 'text' ? await decryptMessage(msg.content, msg.iv, sharedKey) : msg.content;
          const chatId = msg.recipientId === userId ? msg.senderId : msg.recipientId;
          dispatch(addMessage({ recipientId: chatId, message: { ...msg, content: decryptedContent } }));
        }
      }
    };
    loadOfflineMessages();

    const fetchMessages = async (pageNum = 0, isInitialLoad = true) => {
      if (!selectedChat || loading) return;
      setLoading(true);
      try {
        const cachedMessages = JSON.parse(localStorage.getItem(`chat_${selectedChat}`)) || [];
        let messages = [];

        if (cachedMessages.length > 0 && pageNum === 0) {
          messages = cachedMessages.slice(-messagesPerPage);
          setHasMore(cachedMessages.length >= messagesPerPage);
        } else {
          const { data } = await axios.get('/social/messages', {
            headers: { Authorization: `Bearer ${token}` },
            params: { userId, recipientId: selectedChat, limit: messagesPerPage, skip: pageNum * messagesPerPage },
          });
          const sharedKey = await getSharedKey(selectedChat);
          messages = await Promise.all(
            data.messages.map(async (msg) => ({
              ...msg,
              content: msg.contentType === 'text' ? await decryptMessage(msg.content, msg.iv, sharedKey) : msg.content,
              status: msg.status || 'sent',
            }))
          );
          setHasMore(data.hasMore);
          const updatedCachedMessages = [...cachedMessages, ...data.messages].reduce((acc, msg) => {
            if (!acc.some((m) => m._id === msg._id)) acc.push(msg);
            return acc;
          }, []);
          localStorage.setItem(`chat_${selectedChat}`, JSON.stringify(updatedCachedMessages));
          await saveMessages(data.messages);
        }

        messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        if (isInitialLoad) {
          dispatch(setMessages({ recipientId: selectedChat, messages }));
          const unreadMessages = messages.filter((msg) => msg.recipientId === userId && msg.status !== 'read');
          if (unreadMessages.length > 0) {
            unreadMessages.forEach((msg) => {
              socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
            });
          }
          setNotifications((prev) => {
            const updatedNotifications = { ...prev, [selectedChat]: 0 };
            localStorage.setItem('chatNotifications', JSON.stringify(updatedNotifications));
            return updatedNotifications;
          });
          setUnreadCount(0);
          setFirstUnreadMessageId(null);

          setTimeout(() => {
            const lastMessageElement = document.getElementById(`message-${messages[messages.length - 1]?._id}`);
            if (lastMessageElement) lastMessageElement.scrollIntoView({ behavior: 'auto', block: 'end' });
          }, 100);
        } else {
          dispatch(setMessages({
            recipientId: selectedChat,
            messages: [...messages, ...(chats[selectedChat] || [])],
          }));
        }
      } catch (error) {
        console.error('Fetch messages error:', error);
        if (isInitialLoad) {
          dispatch(setMessages({ recipientId: selectedChat, messages: [] }));
          setError('No previous messages');
        }
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
          const { data } = await axios.get(`/social/user-status/${selectedChat}`, {
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
      const decryptedContent = msg.contentType === 'text' ? await decryptMessage(msg.content, msg.iv, sharedKey) : msg.content;
      const senderKnown = users.some((u) => u.id === msg.senderId);
      const updatedMsg = { ...msg, content: decryptedContent, username: senderKnown ? msg.senderUsername : 'Unsaved Number' };
    
      const existingMessage = (chats[chatId] || []).find((m) => m._id === msg._id);
      if (!existingMessage) {
        dispatch(addMessage({ recipientId: chatId, message: updatedMsg }));
        const cachedMessages = JSON.parse(localStorage.getItem(`chat_${chatId}`)) || []; // Fixed: Added semicolon
        localStorage.setItem(`chat_${chatId}`, JSON.stringify([...cachedMessages, msg]));
      }
    
      if (msg.recipientId === userId && !senderKnown) {
        setUsers((prev) => {
          const updatedUsers = [
            ...prev,
            { id: msg.senderId, virtualNumber: msg.senderVirtualNumber, username: 'Unsaved Number', photo: msg.senderPhoto || 'https://placehold.co/40x40', unreadCount: 0 },
          ];
          localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
          return updatedUsers;
        });
      }
   
      if ((msg.senderId === userId && msg.recipientId === selectedChat) || (msg.senderId === selectedChat && msg.recipientId === userId)) {
        if (msg.recipientId === userId) {
          socket.emit('messageStatus', { messageId: msg._id, status: 'delivered', recipientId: userId });
          if (isAtBottomRef.current) {
            socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
          } else {
            setUnreadCount((prev) => prev + 1);
            if (!firstUnreadMessageId) setFirstUnreadMessageId(msg._id);
            setShowJumpToBottom(true);
          }
        }
        if (isAtBottomRef.current) {
          setTimeout(() => {
            chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
          }, 100);
        } else {
          setShowJumpToBottom(true);
        }
      } else if (msg.recipientId === userId) {
        setNotifications((prev) => {
          const updatedNotifications = { ...prev, [msg.senderId]: (prev[msg.senderId] || 0) + 1 };
          localStorage.setItem('chatNotifications', JSON.stringify(updatedNotifications));
          return updatedNotifications;
        });
        setUsers((prev) => {
          const updatedUsers = prev.map((user) =>
            user.id === msg.senderId ? { ...user, latestMessage: msg, unreadCount: (user.unreadCount || 0) + 1 } : user
          );
          updatedUsers.sort((a, b) => {
            const dateA = a.latestMessage ? new Date(a.latestMessage.createdAt) : new Date(0);
            const dateB = b.latestMessage ? new Date(b.latestMessage.createdAt) : new Date(0);
            return dateB - dateA;
          });
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
      if (status === 'read') {
        setUsers((prev) =>
          prev.map((user) =>
            user.id === selectedChat ? { ...user, unreadCount: 0 } : user
          )
        );
      }
    });

    socket.on('onlineStatus', ({ userId: contactId, status, lastSeen }) => {
      setUsers((prev) =>
        prev.map((user) =>
          user.id === contactId ? { ...user, status, lastSeen } : user
        )
      );
      if (contactId === selectedChat) {
        setUserStatus({ status, lastSeen });
      }
    });

    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setShowMenu(false);
      if (messageMenuRef.current && !messageMenuRef.current.contains(event.target)) setShowMessageMenu(null);
    };
    document.addEventListener('mousedown', handleClickOutside);

    const handleScroll = () => {
      if (chatRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
        isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 100;
        setShowJumpToBottom(!isAtBottomRef.current);

        if (scrollTop < 100 && hasMore && !loading) {
          setPage((prevPage) => prevPage + 1);
        }

        // Mark messages as read when scrolled into view
        if (isAtBottomRef.current && selectedChat) {
          const unreadMessages = (chats[selectedChat] || []).filter((msg) => msg.recipientId === userId && msg.status !== 'read');
          unreadMessages.forEach((msg) => {
            socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
          });
          setUnreadCount(0);
          setFirstUnreadMessageId(null);
        }
      }
    };
    chatRef.current?.addEventListener('scroll', handleScroll);

    if (isSmallDevice) {
      const bottomNav = document.querySelector('.bottom-nav');
      if (bottomNav) bottomNav.style.zIndex = '10';
    }

    if (page > 0) fetchMessages(page, false);

    const handleOnline = async () => {
      if (pendingMessages.length > 0) {
        for (const msg of pendingMessages) {
          await sendMessageToServer(msg);
        }
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
      document.removeEventListener('mousedown', handleClickOutside);
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
    if (msgData.contentType === 'text') formData.append('iv', msgData.iv);
    if (msgData.file) formData.append('content', msgData.file);
    else formData.append('content', msgData.content);
    if (msgData.replyTo) formData.append('replyTo', msgData.replyTo);

    try {
      if (msgData.file) setUploadProgress(0);
      const { data } = await axios.post('/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
        onUploadProgress: (progressEvent) => {
          if (msgData.file) setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total));
        },
      });
      socket.emit('message', { ...data, senderVirtualNumber: localStorage.getItem('virtualNumber'), senderUsername: localStorage.getItem('username'), senderPhoto: localStorage.getItem('photo') });
      dispatch(setMessages({
        recipientId: selectedChat,
        messages: (chats[selectedChat] || []).map((msg) => (msg._id === msgData.tempId ? { ...data, content: msg.content, status: 'sent' } : msg)),
      }));
      const cachedMessages = JSON.parse(localStorage.getItem(`chat_${selectedChat}`)) || [];
      const updatedCachedMessages = cachedMessages.map((msg) =>
        msg._id === msgData.tempId ? { ...data, status: 'sent' } : msg
      );
      localStorage.setItem(`chat_${selectedChat}`, JSON.stringify(updatedCachedMessages));
      setUploadProgress(null);
    } catch (error) {
      console.error('Send message error:', error);
      dispatch(setMessages({
        recipientId: selectedChat,
        messages: (chats[selectedChat] || []).filter((msg) => msg._id !== msgData.tempId),
      }));
      setUploadProgress(null);
      setError('Failed to send message');
    }
  };

  const sendMessage = async () => {
    if (!selectedChat || (!message && !file && contentType === 'text')) {
      setError('Please enter a message or select a file');
      return;
    }

    socket.emit('stopTyping', { userId, recipientId: selectedChat });
    setTyping(false);

    const sharedKey = await getSharedKey(selectedChat);
    const { encrypted, iv } = contentType === 'text' ? await encryptMessage(message, sharedKey) : { encrypted: message, iv: '' };
    const tempId = Date.now().toString();
    const tempMsg = {
      _id: tempId,
      senderId: userId,
      recipientId: selectedChat,
      contentType,
      content: file ? URL.createObjectURL(file) : message,
      iv,
      caption,
      status: 'sent',
      replyTo,
      createdAt: new Date(),
      tempId,
    };

    dispatch(addMessage({ recipientId: selectedChat, message: tempMsg }));
    const cachedMessages = JSON.parse(localStorage.getItem(`chat_${selectedChat}`)) || [];
    localStorage.setItem(`chat_${selectedChat}`, JSON.stringify([...cachedMessages, { ...tempMsg, content: encrypted }]));

    if (isAtBottomRef.current) {
      setTimeout(() => {
        chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
      }, 0);
    } else {
      setShowJumpToBottom(true);
    }

    setMessage('');
    setFile(null);
    setCaption('');
    setContentType('text');
    setShowPicker(false);
    setUploadProgress(null);
    setReplyTo(null);
    setMediaPreview(null);
    setError('');

    if (navigator.onLine) {
      await sendMessageToServer({ ...tempMsg, content: encrypted, file, iv });
    } else {
      setPendingMessages((prev) => [...prev, { ...tempMsg, content: encrypted, file, iv }]);
      await saveMessages([{ ...tempMsg, content: encrypted, iv }]);
    }
  };

  const handleTyping = (e) => {
    setMessage(e.target.value);
    if (!typing) {
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
          axios.delete(`/social/message/${messageId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        )
      );
      dispatch(setMessages({
        recipientId: selectedChat,
        messages: (chats[selectedChat] || []).filter((msg) => !selectedMessages.includes(msg._id)),
      }));
      const cachedMessages = JSON.parse(localStorage.getItem(`chat_${selectedChat}`)) || [];
      const updatedCachedMessages = cachedMessages.filter((msg) => !selectedMessages.includes(msg._id));
      localStorage.setItem(`chat_${selectedChat}`, JSON.stringify(updatedCachedMessages));
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
    const { encrypted, iv } = msg.contentType === 'text' ? await encryptMessage(msg.content, sharedKey) : { encrypted: msg.content, iv: msg.iv || '' };
    const formData = new FormData();
    formData.append('senderId', userId);
    formData.append('recipientId', contact.id);
    formData.append('contentType', msg.contentType);
    formData.append('caption', msg.caption || '');
    formData.append('content', encrypted);
    if (msg.contentType === 'text') formData.append('iv', iv);

    try {
      const { data } = await axios.post('/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      socket.emit('message', { ...data, senderVirtualNumber: localStorage.getItem('virtualNumber'), senderUsername: localStorage.getItem('username'), senderPhoto: localStorage.getItem('photo') });
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
    } else {
      alert('Sharing not supported on this device');
    }
  };

  const addContact = async () => {
    try {
      const { data } = await axios.post('/auth/add_contact', { userId, virtualNumber: newContactNumber }, { headers: { Authorization: `Bearer ${token}` } });
      if (data.userId) {
        const { publicKey } = await generateDHKeyPair();
        await axios.post('/auth/update_public_key', { userId, publicKey }, { headers: { Authorization: `Bearer ${token}` } });
        setUsers((prev) => {
          const updatedUsers = [...prev, { id: data.userId, virtualNumber: newContactNumber, username: newContactName || data.username || 'Unsaved Number', photo: data.photo || 'https://placehold.co/40x40', unreadCount: 0 }];
          localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
          return updatedUsers;
        });
        setNewContactNumber('');
        setNewContactName('');
        setMenuTab('');
        setError('');
      } else {
        setError('Number not registered');
      }
    } catch (error) {
      setError(error.response?.data?.error || 'Number not available');
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
    unreadMessages.forEach((msg) => {
      socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
    });
  };

  const scrollToMessage = (messageId) => {
    const element = document.getElementById(`message-${messageId}`);
    if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleHoldStart = (msgId) => {
    const timer = setTimeout(() => {
      setShowMessageMenu(msgId);
    }, 1500);
    setHoldTimer(timer);
  };

  const handleHoldEnd = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      setHoldTimer(null);
    }
  };

  const handleSwipeStart = (e) => {
    const touch = e.touches[0];
    setSwipeStartX(touch.clientX);
  };

  const handleSwipeMove = (e) => {
    if (swipeStartX === null) return;
    const touch = e.touches[0];
    const swipeDistance = touch.clientX - swipeStartX;
  };

  const handleSwipeEnd = (e, msg) => {
    if (swipeStartX === null) return;
    const touch = e.changedTouches[0];
    const swipeDistance = touch.clientX - swipeStartX;
    if (swipeDistance < -50) {
      setReplyTo(msg);
      scrollToMessage(msg._id);
    }
    setSwipeStartX(null);
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
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="flex h-screen bg-gray-100">
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
                  <span className="absolute bottom-0 right-3 w-5 h-5 bg-green-500 border-2 border-white rounded-full"></span>
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
                  <span className="text-sm text-gray-600 truncate">
                    {user.latestMessage ? (
                      <>
                        {user.latestMessage.senderId === userId && 'You: '}
                        {user.latestMessage.contentType === 'text'
                          ? user.latestMessage.content.slice(0, 30) + (user.latestMessage.content.length > 30 ? '...' : '')
                          : '(Attachment)'}
                      </>
                    ) : (
                      'No messages yet'
                    )}
                  </span>
                  {(user.unreadCount || notifications[user.id]) > 0 && (
                    <span className="ml-auto bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
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
            ref={menuRef}
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
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  onClick={() => setMenuTab('newGroup')}
                  className={`flex items-center p-3 rounded-lg cursor-pointer ${menuTab === 'newGroup' ? 'bg-gray-200' : ''}`}
                >
                  <FaUsers className="text-primary mr-3" />
                  <span className="text-primary">New Group</span>
                </motion.div>
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  onClick={() => setMenuTab('theme')}
                  className={`flex items-center p-3 rounded-lg cursor-pointer ${menuTab === 'theme' ? 'bg-gray-200' : ''}`}
                >
                  <FaPaintBrush className="text-primary mr-3" />
                  <span className="text-primary">Theme</span>
                </motion.div>
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  onClick={() => setMenuTab('settings')}
                  className={`flex items-center p-3 rounded-lg cursor-pointer ${menuTab === 'settings' ? 'bg-gray-200' : ''}`}
                >
                  <FaCog className="text-primary mr-3" />
                  <span className="text-primary">Account & Settings</span>
                </motion.div>
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  onClick={handleLogout}
                  className="flex items-center p-3 rounded-lg cursor-pointer text-red-500 hover:bg-gray-200"
                >
                  <FaSignOutAlt className="text-red-500 mr-3" />
                  <span className="text-red-500">Logout</span>
                </motion.div>
              </div>
              <AnimatePresence>
                {menuTab === 'newNumber' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-4"
                  >
                    <input
                      type="text"
                      value={newContactNumber}
                      onChange={(e) => setNewContactNumber(e.target.value)}
                      className="w-full p-2 mb-2 border rounded-lg"
                      placeholder="Enter virtual number"
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
                  </motion.div>
                )}
                {menuTab === 'newGroup' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-4"
                  >
                    <p className="text-gray-500">New Group feature coming soon!</p>
                  </motion.div>
                )}
                {menuTab === 'theme' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-4"
                  >
                    <p className="text-gray-500">Theme customization coming soon!</p>
                  </motion.div>
                )}
                {menuTab === 'settings' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-4"
                  >
                    <p className="text-gray-500">Account & Settings coming soon!</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </div>

      <div className={`flex-1 flex flex-col ${isSmallDevice && !selectedChat ? 'hidden' : 'block'}`}>
        {selectedChat ? (
          <>
            <div className="bg-white p-3 flex items-center border-b border-gray-200 fixed top-0 md:left-[33.33%] md:w-2/3 left-0 right-0 z-10">
              {isSmallDevice && (
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaArrowLeft
                    onClick={() => dispatch(setSelectedChat(null))}
                    className="text-xl text-primary cursor-pointer mr-3 hover:text-secondary"
                  />
                </motion.div>
              )}
              <img src={users.find((u) => u.id === selectedChat)?.photo || 'https://placehold.co/40x40'} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
              <div>
                <span className="font-semibold">{users.find((u) => u.id === selectedChat)?.username || users.find((u) => u.id === selectedChat)?.virtualNumber || 'Unknown'}</span>
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
            <div ref={chatRef} className="flex-1 overflow-y-auto bg-gray-100 p-2 pt-16 pb-32">
              {(chats[selectedChat] || []).length === 0 ? (
                <p className="text-center text-gray-500 mt-4">Start a new conversation</p>
              ) : (
                <>
                  {(chats[selectedChat] || []).map((msg, index) => {
                    const currentDate = new Date(msg.createdAt);
                    const prevMsg = index > 0 ? (chats[selectedChat] || [])[index - 1] : null;
                    const prevDate = prevMsg ? new Date(prevMsg.createdAt) : null;

                    let showDateHeader = !prevDate || new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()).getTime() !== new Date(prevDate.getFullYear(), prevDate.getMonth(), prevDate.getDate()).getTime();

                    return (
                      <motion.div
                        key={msg._id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3 }}
                      >
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
                          id={`message-${msg._id}`}
                          className={`flex ${msg.senderId === userId ? 'justify-end' : 'justify-start'} px-2 py-1 relative`}
                          onTouchStart={(e) => { handleHoldStart(msg._id); handleSwipeStart(e); }}
                          onTouchMove={handleSwipeMove}
                          onTouchEnd={(e) => { handleHoldEnd(); handleSwipeEnd(e, msg); }}
                          onMouseDown={() => handleHoldStart(msg._id)}
                          onMouseUp={handleHoldEnd}
                        >
                          <div
                            className={`max-w-[70%] p-2 rounded-lg shadow-sm ${msg.senderId === userId ? 'bg-green-500 text-white rounded-br-none' : 'bg-white text-black rounded-bl-none'} transition-all ${selectedMessages.includes(msg._id) ? 'bg-opacity-50' : ''}`}
                            onClick={() => {
                              if (selectedMessages.length > 0) {
                                setSelectedMessages((prev) =>
                                  prev.includes(msg._id) ? prev.filter((id) => id !== msg._id) : [...prev, msg._id]
                                );
                              }
                            }}
                            onDoubleClick={msg.contentType === 'video' ? () => viewMessage(msg) : null}
                          >
                            {msg.replyTo && (
                              <div className="bg-gray-100 p-1 rounded mb-1 text-xs italic text-gray-700 border-l-4 border-green-500">
                                {msg.replyTo.contentType === 'text' && (
                                  <p>{msg.replyTo.content.slice(0, 20) + (msg.replyTo.content.length > 20 ? '...' : '')}</p>
                                )}
                                {msg.replyTo.contentType === 'image' && (
                                  <div className="flex items-center">
                                    <img src={msg.replyTo.content} alt="Reply Preview" className="w-8 h-8 object-cover rounded mr-2" />
                                    <span>Image</span>
                                  </div>
                                )}
                                {msg.replyTo.contentType === 'video' && (
                                  <div className="flex items-center">
                                    <video src={msg.replyTo.content} className="w-8 h-8 object-cover rounded mr-2" />
                                    <span>Video</span>
                                  </div>
                                )}
                                {msg.replyTo.contentType === 'audio' && (
                                  <div className="flex items-center">
                                    <FaPlay className="text-green-500 mr-2" />
                                    <span>Audio</span>
                                  </div>
                                )}
                                {msg.replyTo.contentType === 'document' && (
                                  <div className="flex items-center">
                                    <FaFileAlt className="text-blue-600 mr-2" />
                                    <span>Document</span>
                                  </div>
                                )}
                              </div>
                            )}
                            {msg.contentType === 'text' && <p className="text-sm break-words">{msg.content}</p>}
                            {msg.contentType === 'image' && (
                              <div className="relative border-t border-l border-r border-gray-300 rounded-lg shadow-md p-1">
                                <img
                                  src={msg.content}
                                  alt="Chat"
                                  className="max-w-[80%] max-h-64 object-contain rounded-lg"
                                  onClick={(e) => { e.stopPropagation(); viewMessage(msg); }}
                                />
                                {msg.caption && (
                                  <p className="text-xs italic text-gray-300 max-w-[80%] p-2 border-b border-l border-r border-gray-300 rounded-b-lg break-words">{msg.caption}</p>
                                )}
                              </div>
                            )}
                            {msg.contentType === 'video' && (
                              <div className="relative border-t border-l border-r border-gray-300 rounded-lg shadow-md p-1">
                                <video
                                  src={msg.content}
                                  className="max-w-[80%] max-h-64 object-contain rounded-lg"
                                  onClick={(e) => e.stopPropagation()}
                                />
                                {msg.caption && (
                                  <p className="text-xs italic text-gray-300 max-w-[80%] p-2 border-b border-l border-r border-gray-300 rounded-b-lg break-words">{msg.caption}</p>
                                )}
                              </div>
                            )}
                            {msg.contentType === 'audio' && (
                              <div className="relative flex items-center">
                                <audio
                                  src={msg.content}
                                  controls
                                  className="max-w-[80%] h-10"
                                  onError={(e) => console.error('Audio playback error:', e)}
                                />
                                {msg.caption && <p className="text-xs mt-1 italic text-gray-300 ml-2">{msg.caption}</p>}
                              </div>
                            )}
                            {msg.contentType === 'document' && (
                              <div className="flex items-center bg-gray-100 p-2 rounded-lg">
                                <FaFileAlt className="text-blue-600 mr-2" />
                                <span className="text-blue-600 font-semibold truncate max-w-[200px] text-sm">
                                  {msg.content.split('/').pop().slice(0, 30) + (msg.content.split('/').pop().length > 30 ? '...' : '')}
                                </span>
                                <a
                                  href={msg.content}
                                  download
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="ml-2 text-blue-600 hover:text-blue-800"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <FaDownload />
                                </a>
                                {msg.caption && <p className="text-xs ml-2 italic text-gray-600">{msg.caption}</p>}
                              </div>
                            )}
                            <div className="flex justify-between items-center mt-1">
                              {msg.senderId === userId && (
                                <span className="text-xs">
                                  {msg.status === 'sent' && '✔'}
                                  {msg.status === 'delivered' && '✔✔'}
                                  {msg.status === 'read' && <span className="text-blue-500">✔✔</span>}
                                </span>
                              )}
                              <span className="text-xs text-gray-500">{formatTime(msg.createdAt)}</span>
                            </div>
                          </div>
                          {showMessageMenu === msg._id && (
                            <motion.div
                              ref={messageMenuRef}
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{ opacity: 1, scale: 1 }}
                              className={`absolute ${msg.senderId === userId ? 'right-0' : 'left-0'} top-0 bg-white p-2 rounded-lg shadow-lg z-20 flex space-x-2`}
                            >
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaReply
                                  onClick={() => { setReplyTo(msg); scrollToMessage(msg._id); setShowMessageMenu(null); }}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaForward
                                  onClick={() => { forwardMessage(msg); setShowMessageMenu(null); }}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaCopy
                                  onClick={() => { copyMessage(msg); setShowMessageMenu(null); }}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaShare
                                  onClick={() => { shareMessage(msg); setShowMessageMenu(null); }}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              {msg.senderId === userId && (
                                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                  <FaTrash
                                    onClick={() => {
                                      setSelectedMessages([msg._id]);
                                      setShowDeleteConfirm(true);
                                      setShowMessageMenu(null);
                                    }}
                                    className="text-red-500 cursor-pointer hover:text-red-700"
                                  />
                                </motion.div>
                              )}
                            </motion.div>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                  {loading && page > 0 && (
                    <div className="text-center py-2">
                      <p className="text-gray-500">Loading more messages...</p>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="bg-white p-2 border-t border-gray-200 shadow-lg fixed bottom-0 md:left-[33.33%] md:w-2/3 left-0 right-0 z-30 mb-16">
              {mediaPreview && (
                <div className="bg-gray-100 p-2 mb-2 rounded w-full max-w-[80%] mx-auto">
                  {mediaPreview.type === 'image' && (
                    <img src={mediaPreview.url} alt="Preview" className="max-w-full max-h-64 object-contain rounded-lg p-[2px]" />
                  )}
                  {mediaPreview.type === 'video' && (
                    <video src={mediaPreview.url} className="max-w-full max-h-64 object-contain rounded-lg p-[2px]" controls />
                  )}
                  {mediaPreview.type === 'audio' && (
                    <div className="flex items-center">
                      <FaPlay className="text-green-500 mr-2" />
                      <div className={`bg-gray-200 h-2 rounded-full ${isSmallDevice ? 'w-[250px]' : 'w-[400px]'}`}>
                        <div className="bg-green-500 h-2 rounded-full w-1/3"></div>
                      </div>
                    </div>
                  )}
                  {mediaPreview.type === 'document' && (
                    <div className="flex items-center">
                      <FaFileAlt className="text-blue-600 mr-2" />
                      <span className="text-blue-600 font-semibold truncate max-w-[200px] text-sm">
                        {mediaPreview.name.slice(0, 30) + (mediaPreview.name.length > 30 ? '...' : '')}
                      </span>
                    </div>
                  )}
                  <input
                    type="text"
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    placeholder="Add a caption..."
                    className="w-full p-1 mt-2 border rounded-lg text-sm"
                    style={{ maxWidth: mediaPreview.type === 'image' || mediaPreview.type === 'video' ? '80%' : '100%' }}
                  />
                  <button onClick={() => setMediaPreview(null)} className="text-red-500 text-xs mt-1">Cancel</button>
                </div>
              )}
              {uploadProgress !== null && (
                <div className="bg-gray-100 p-2 mb-2 rounded w-full max-w-[80%] mx-auto">
                  <div className="w-full bg-gray-200 rounded-full h-2.5">
                    <div className="bg-green-500 h-2.5 rounded-full" style={{ width: `${uploadProgress}%` }}></div>
                  </div>
                  <p className="text-xs text-center mt-1">Uploading: {uploadProgress}%</p>
                </div>
              )}
              {selectedMessages.length > 0 && (
                <div className="flex items-center w-full mb-2">
                  <button onClick={() => setShowDeleteConfirm(true)} className="bg-red-500 text-white px-3 py-1 rounded mr-2">
                    Delete ({selectedMessages.length})
                  </button>
                  <button onClick={() => setSelectedMessages([])} className="bg-gray-500 text-white px-3 py-1 rounded">
                    Cancel
                  </button>
                </div>
              )}
              {replyTo && (
                <div className="bg-gray-100 p-2 mb-2 rounded w-full">
                  <p className="text-sm italic">Replying to: {replyTo.content.slice(0, 20)}...</p>
                  <button onClick={() => setReplyTo(null)} className="text-red-500 text-xs">Cancel</button>
                </div>
              )}
              <div className={`flex items-center ${isSmallDevice ? 'w-[90%]' : 'w-full max-w-3xl'} mx-auto pb-4`}>
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaPaperclip
                    className="text-xl text-gray-500 cursor-pointer hover:text-gray-700 mr-2"
                    onClick={() => setShowPicker(!showPicker)}
                  />
                </motion.div>
                <input
                  value={message}
                  onChange={handleTyping}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  className="flex-1 p-2 border rounded-full focus:ring-2 focus:ring-green-500 bg-gray-100 text-sm"
                  placeholder="Type a message..."
                />
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaPaperPlane
                    className="text-xl text-green-500 cursor-pointer hover:text-green-700 ml-2"
                    onClick={sendMessage}
                  />
                </motion.div>
              </div>
              {showPicker && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="absolute bottom-16 left-4 bg-white p-2 rounded-lg shadow-lg flex space-x-2 z-20"
                >
                  {['image', 'video', 'audio', 'document'].map((type) => (
                    <motion.label
                      key={type}
                      whileHover={{ scale: 1.1 }}
                      className="p-2 bg-green-500 text-white rounded hover:bg-green-600 text-sm cursor-pointer"
                    >
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                      <input
                        type="file"
                        accept={type === 'image' ? 'image/*' : type === 'video' ? 'video/*' : type === 'audio' ? 'audio/*' : '*/*'}
                        onChange={(e) => handleFileChange(e, type)}
                        className="hidden"
                      />
                    </motion.label>
                  ))}
                </motion.div>
              )}
            </div>
            {showJumpToBottom && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="fixed bottom-20 right-4 bg-green-500 text-white p-2 rounded-full cursor-pointer z-20"
                onClick={jumpToBottom}
              >
                <FaArrowDown />
                <span className="ml-2 text-sm">New Messages</span>
              </motion.div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-gray-500">Select a chat to start messaging</p>
          </div>
        )}
      </div>
      {viewMedia && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 bg-black flex items-center justify-center z-50"
          onClick={() => setViewMedia(null)}
        >
          <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
            <FaArrowLeft
              onClick={(e) => { e.stopPropagation(); setViewMedia(null); }}
              className="absolute top-4 left-4 text-white text-2xl cursor-pointer hover:text-gray-300"
            />
          </motion.div>
          <div className="relative max-w-[90%] max-h-[90%] flex items-center justify-center">
            {viewMedia.type === 'image' && (
              <img src={viewMedia.url} alt="Media" className="max-w-full max-h-full object-contain rounded-lg" />
            )}
            {viewMedia.type === 'video' && (
              <video src={viewMedia.url} controls autoPlay className="max-w-full max-h-full object-contain rounded-lg" />
            )}
            {viewMedia.type === 'audio' && (
              <div className="bg-gray-800 p-4 rounded-lg">
                <audio src={viewMedia.url} controls className="w-full max-w-md" />
              </div>
            )}
            {viewMedia.type === 'document' && (
              <div className="bg-gray-800 p-4 rounded-lg flex items-center">
                <FaFileAlt className="text-white text-2xl mr-3" />
                <span className="text-white text-lg truncate max-w-[200px]">{viewMedia.url.split('/').pop()}</span>
                <a
                  href={viewMedia.url}
                  download
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-3 text-white hover:text-gray-300"
                  onClick={(e) => e.stopPropagation()}
                >
                  <FaDownload className="text-2xl" />
                </a>
              </div>
            )}
          </div>
          {(viewMedia.type === 'image' || viewMedia.type === 'video') && (
            <a
              href={viewMedia.url}
              download
              target="_blank"
              rel="noopener noreferrer"
              className="absolute bottom-4 right-4 text-white hover:text-gray-300"
              onClick={(e) => e.stopPropagation()}
            >
              <FaDownload className="text-2xl" />
            </a>
          )}
        </motion.div>
      )}

      {showDeleteConfirm && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
        >
          <div className="bg-white p-6 rounded-lg shadow-lg w-full max-w-sm">
            <h3 className="text-lg font-semibold text-primary mb-4">Delete {selectedMessages.length} message{selectedMessages.length > 1 ? 's' : ''}?</h3>
            <p className="text-gray-600 mb-4">This action cannot be undone.</p>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="bg-gray-500 text-white px-4 py-2 rounded-lg hover:bg-gray-600">Cancel</button>
              <button onClick={deleteMessages} className="bg-red-500 text-white px-4 py-2 rounded-lg hover:bg-red-600">Delete</button>
            </div>
          </div>
        </motion.div>
      )}

      {error && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-500 text-white px-4 py-2 rounded-lg shadow-lg z-50"
        >
          {error}
          <button onClick={() => setError('')} className="ml-2 text-white hover:text-gray-200">✕</button>
        </motion.div>
      )}
    </motion.div>
  );
};

export default ChatScreen;