// @ts-nocheck
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
  FaUsers,
  FaPaintBrush,
  FaCog,
  FaSignOutAlt,
} from 'react-icons/fa';
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
  const [decryptionPending, setDecryptionPending] = useState({});
  const chatRef = useRef(null);
  const menuRef = useRef(null);
  const messageMenuRef = useRef(null);
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
      if (response.data.error) {
        if (response.data.code === 'NO_SHARED_KEY') {
          console.warn('No shared key - sending unencrypted');
          return null;
        }
        throw new Error(response.data.error);
      }
      return response.data.sharedKey;
    } catch (error) {
      console.error('Error getting shared key:', error.message);
      return null;
    }
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
    }, 30000);

    const fetchUsers = async () => {
      try {
        const cachedUsers = JSON.parse(localStorage.getItem('cachedUsers')) || [];
        if (cachedUsers.length > 0) {
          setUsers(cachedUsers);
          const usersWithLatestMessage = await Promise.all(
            cachedUsers.map(async (user) => {
              if (!user.id) {
                console.warn('User missing ID:', user);
                return { ...user, latestMessage: null, unreadCount: 0 }; // Skip fetch for invalid users
              }
              try {
                const { data } = await axios.get('https://gapp-6yc3.onrender.com/social/messages', {
                  headers: { Authorization: `Bearer ${token}` },
                  params: { userId, recipientId: user.id, limit: 1, skip: 0 },
                });
                const latestMessage = data.messages.length > 0 ? data.messages[0] : null;
                const unreadCount = latestMessage && latestMessage.recipientId === userId && latestMessage.status !== 'read' ? 1 : 0;
                return { ...user, latestMessage, unreadCount };
              } catch (error) {
                console.error(`Error fetching latest message for user ${user.id}:`, error.response?.status || error.message);
                return { ...user, latestMessage: null, unreadCount: 0 }; // Default to no message
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
          const { data } = await axios.get('https://gapp-6yc3.onrender.com/auth/contacts', {
            headers: { Authorization: `Bearer ${token}` },
          });
          const usersWithLatestMessage = await Promise.all(
            data.map(async (user) => {
              if (!user.id) {
                console.warn('Contact missing ID:', user);
                return { ...user, latestMessage: null, unreadCount: 0 };
              }
              try {
                const { data: messagesData } = await axios.get('https://gapp-6yc3.onrender.com/social/messages', {
                  headers: { Authorization: `Bearer ${token}` },
                  params: { userId, recipientId: user.id, limit: 1, skip: 0 },
                });
                const latestMessage = messagesData.messages.length > 0 ? messagesData.messages[0] : null;
                const unreadCount = latestMessage && latestMessage.recipientId === userId && latestMessage.status !== 'read' ? 1 : 0;
                return { ...user, latestMessage, unreadCount };
              } catch (error) {
                console.error(`Error fetching latest message for user ${user.id}:`, error.response?.status || error.message);
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
        console.error('Fetch users error:', error);
        setError('Failed to load contacts');
      }
    };
    fetchUsers();

    const loadOfflineMessages = async () => {
      const offlineMessages = await getMessages(selectedChat);
      if (offlineMessages.length > 0) {
        const pendingDecryption = {};
        for (const msg of offlineMessages) {
          const chatId = msg.recipientId === userId ? msg.senderId : msg.recipientId;
          if (msg.contentType === 'text' && msg.iv) {
            pendingDecryption[msg._id] = { encryptedContent: msg.content, iv: msg.iv };
            dispatch(addMessage({ recipientId: chatId, message: { ...msg, content: 'Message encrypted, awaiting key' } }));
          } else {
            dispatch(addMessage({ recipientId: chatId, message: msg }));
          }
        }
        setDecryptionPending(pendingDecryption);
      }
    };

    const decryptPendingMessages = async () => {
      if (Object.keys(decryptionPending).length === 0 || !navigator.onLine) return;

      const updatedMessages = [];
      for (const [messageId, { encryptedContent, iv }] of Object.entries(decryptionPending)) {
        const chatId = (chats[selectedChat] || []).find((m) => m._id === messageId)?.senderId === userId ? selectedChat : userId;
        const sharedKey = await getSharedKey(chatId);
        if (sharedKey) {
          try {
            const decryptedContent = await decryptMessage(encryptedContent, iv, sharedKey);
            updatedMessages.push({ _id: messageId, content: decryptedContent });
          } catch (error) {
            console.error(`Failed to decrypt message ${messageId}:`, error);
          }
        }
      }

      if (updatedMessages.length > 0) {
        dispatch(
          setMessages({
            recipientId: selectedChat,
            messages: (chats[selectedChat] || []).map((msg) =>
              updatedMessages.find((um) => um._id === msg._id) ? { ...msg, content: updatedMessages.find((um) => um._id === msg._id).content } : msg
            ),
          })
        );
        setDecryptionPending({});
      }
    };

    if (selectedChat) {
      setPage(0);
      setHasMore(true);
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
            const { data } = await axios.get('https://gapp-6yc3.onrender.com/social/messages', {
              headers: { Authorization: `Bearer ${token}` },
              params: { userId, recipientId: selectedChat, limit: messagesPerPage, skip: pageNum * messagesPerPage },
            });
            const sharedKey = await getSharedKey(selectedChat);
            messages = await Promise.all(
              data.messages.map(async (msg) => ({
                ...msg,
                content: msg.contentType === 'text' && sharedKey ? await decryptMessage(msg.content, msg.iv, sharedKey) : msg.content,
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
            dispatch(
              setMessages({
                recipientId: selectedChat,
                messages: [...messages, ...(chats[selectedChat] || [])],
              })
            );
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
      const decryptedContent = msg.contentType === 'text' && sharedKey ? await decryptMessage(msg.content, msg.iv, sharedKey) : msg.content;
      const senderKnown = users.some((u) => u.id === msg.senderId);
      const updatedMsg = { ...msg, content: decryptedContent, username: senderKnown ? msg.senderUsername : 'Unsaved Number' };

      const existingMessage = (chats[chatId] || []).find((m) => m._id === msg._id);
      if (!existingMessage) {
        dispatch(addMessage({ recipientId: chatId, message: updatedMsg }));
        const cachedMessages = JSON.parse(localStorage.getItem(`chat_${chatId}`)) || [];
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
        setUsers((prev) => prev.map((user) => (user.id === selectedChat ? { ...user, unreadCount: 0 } : user)));
      }
    });

    socket.on('onlineStatus', ({ userId: contactId, status, lastSeen }) => {
      setUsers((prev) => prev.map((user) => (user.id === contactId ? { ...user, status, lastSeen } : user)));
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

    if (page > 0) {
      const fetchMoreMessages = async () => fetchMessages(page, false);
      fetchMoreMessages();
    }

    const handleOnline = async () => {
      if (pendingMessages.length > 0) {
        for (const msg of pendingMessages) {
          await sendMessageToServer(msg);
        }
        setPendingMessages([]);
      }
      await decryptPendingMessages();
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
      const { data } = await axios.post('https://gapp-6yc3.onrender.com/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
        onUploadProgress: (progressEvent) => {
          if (msgData.file) setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total));
        },
      });
      socket.emit('message', {
        ...data,
        senderVirtualNumber: localStorage.getItem('virtualNumber'),
        senderUsername: localStorage.getItem('username'),
        senderPhoto: localStorage.getItem('photo'),
      });
      dispatch(
        setMessages({
          recipientId: selectedChat,
          messages: (chats[selectedChat] || []).map((msg) =>
            msg._id === msgData.tempId ? { ...data, content: msg.content, status: 'sent' } : msg
          ),
        })
      );
      const cachedMessages = JSON.parse(localStorage.getItem(`chat_${selectedChat}`)) || [];
      const updatedCachedMessages = cachedMessages.map((msg) => (msg._id === msgData.tempId ? { ...data, status: 'sent' } : msg));
      localStorage.setItem(`chat_${selectedChat}`, JSON.stringify(updatedCachedMessages));
      setUploadProgress(null);
    } catch (error) {
      console.error('Send message error:', error);
      dispatch(
        setMessages({
          recipientId: selectedChat,
          messages: (chats[selectedChat] || []).filter((msg) => msg._id !== msgData.tempId),
        })
      );
      setUploadProgress(null);
      setError('Failed to send message');
    }
  };

  const sendMessage = async () => {
    try {
      if (!selectedChat) {
        setError('No chat selected');
        return;
      }
      if (!message && !file && contentType === 'text') {
        setError('Please enter a message or select a file');
        return;
      }

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
        replyTo,
        createdAt: new Date(),
        tempId,
      };

      dispatch(addMessage({ recipientId: selectedChat, message: tempMsg }));

      let encryptedContent = message;
      let iv = '';

      if (contentType === 'text') {
        const sharedKey = await getSharedKey(selectedChat);
        if (sharedKey) {
          const encryptionResult = await encryptMessage(message, sharedKey);
          encryptedContent = encryptionResult.encrypted;
          iv = encryptionResult.iv;
        } else {
          console.warn('No encryption key - sending unencrypted');
          setError('Message sent without encryption');
        }
      }

      const cachedMessages = JSON.parse(localStorage.getItem(`chat_${selectedChat}`)) || [];
      const messageForServer = { ...tempMsg, content: encryptedContent, iv, status: 'sent' };
      localStorage.setItem(`chat_${selectedChat}`, JSON.stringify([...cachedMessages, messageForServer]));

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

      if (navigator.onLine) {
        await sendMessageToServer(messageForServer);
        dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: tempId, status: 'sent' }));
      } else {
        setPendingMessages((prev) => [...prev, messageForServer]);
        await saveMessages([messageForServer]);
        dispatch(updateMessageStatus({ recipientId: selectedChat, messageId: tempId, status: 'pending' }));
        if (contentType === 'text' && iv) {
          setDecryptionPending((prev) => ({
            ...prev,
            [tempId]: { encryptedContent, iv },
          }));
        }
      }

      // Update users with the latest message
      setUsers((prev) => {
        const updatedUsers = prev.map((user) =>
          user.id === selectedChat ? { ...user, latestMessage: { ...messageForServer, content: message } } : user
        );
        updatedUsers.sort((a, b) => {
          const dateA = a.latestMessage ? new Date(a.latestMessage.createdAt) : new Date(0);
          const dateB = b.latestMessage ? new Date(b.latestMessage.createdAt) : new Date(0);
          return dateB - dateA;
        });
        localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
        return updatedUsers;
      });
    } catch (error) {
      console.error('Error in sendMessage:', error);
      setError('An unexpected error occurred');
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
      socket.emit('message', {
        ...data,
        senderVirtualNumber: localStorage.getItem('virtualNumber'),
        senderUsername: localStorage.getItem('username'),
        senderPhoto: localStorage.getItem('photo'),
      });
    } catch (error) {
      setError('Failed to forward message');
    }
  };

  const copyMessage = (msg) => {
    if (msg.contentType === 'text' && msg.content !== 'Message encrypted, awaiting key') {
      navigator.clipboard.writeText(msg.content);
      alert('Message copied to clipboard');
    }
  };

  const shareMessage = (msg) => {
    if (navigator.share && msg.content !== 'Message encrypted, awaiting key') {
      navigator.share({
        title: 'Shared Message',
        text: msg.contentType === 'text' ? msg.content : undefined,
        url: msg.contentType !== 'text' ? msg.content : undefined,
      });
    } else {
      alert('Sharing not supported on this device or message is encrypted');
    }
  };

  const addContact = async () => {
    if (!newContactNumber) {
      setError('Virtual number is required');
      return;
    }

    setLoading(true);
    try {
      const { data } = await axios.post(
        'https://gapp-6yc3.onrender.com/auth/add_contact',
        { userId, virtualNumber: newContactNumber },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const newContact = {
        id: data.userId,
        virtualNumber: data.virtualNumber,
        username: newContactName || data.username || 'Unsaved Number',
        photo: data.photo || 'https://placehold.co/40x40',
        unreadCount: 0,
        latestMessage: null, // No messages yet for new contact
        status: 'offline',
        lastSeen: null,
      };

      setUsers((prev) => {
        const updatedUsers = [...prev, newContact];
        updatedUsers.sort((a, b) => {
          const dateA = a.latestMessage ? new Date(a.latestMessage.createdAt) : new Date(0);
          const dateB = b.latestMessage ? new Date(b.latestMessage.createdAt) : new Date(0);
          return dateB - dateA;
        });
        localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
        return updatedUsers;
      });

      setNewContactNumber('');
      setNewContactName('');
      setMenuTab('');
      setError('');
      setLoading(false);
      dispatch(setSelectedChat(data.userId)); // Open chat box for new contact
    } catch (error) {
      console.error('Add contact error:', error);
      setLoading(false);
      const errorMessage = error.response?.data?.error || 'Failed to add contact';
      setError(errorMessage);
      if (error.response?.status === 404) {
        setError('Contact service unavailable. Please try again later.');
      } else if (error.response?.status === 400) {
        setError('Invalid virtual number or contact already exists.');
      }
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
              key={user.id || user.virtualNumber} // Use virtualNumber as fallback key if id is missing
              whileHover={{ backgroundColor: '#f0f0f0' }}
              onClick={() => user.id && dispatch(setSelectedChat(user.id))} // Only set chat if id exists
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
                    {user.latestMessage ? user.latestMessage.content : 'No messages yet'}
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
                      disabled={loading}
                    />
                    <input
                      type="text"
                      value={newContactName}
                      onChange={(e) => setNewContactName(e.target.value)}
                      className="w-full p-2 mb-2 border rounded-lg"
                      placeholder="Enter contact name (optional)"
                      disabled={loading}
                    />
                    <button
                      onClick={addContact}
                      className="w-full bg-primary text-white p-2 rounded-lg hover:bg-secondary disabled:bg-gray-400"
                      disabled={loading}
                    >
                      {loading ? 'Saving...' : 'Save Contact'}
                    </button>
                    {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
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
              <img
                src={users.find((u) => u.id === selectedChat)?.photo || 'https://placehold.co/40x40'}
                alt="Profile"
                className="w-10 h-10 rounded-full mr-2"
              />
              <div>
                <span className="font-semibold">
                  {users.find((u) => u.id === selectedChat)?.username || users.find((u) => u.id === selectedChat)?.virtualNumber || 'Unknown'}
                </span>
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
                <p className="text-center text-gray-500 mt-4">No messages yet</p>
              ) : (
                <>
                  {(chats[selectedChat] || []).map((msg, index) => {
                    const currentDate = new Date(msg.createdAt);
                    const prevMsg = index > 0 ? (chats[selectedChat] || [])[index - 1] : null;
                    const prevDate = prevMsg ? new Date(prevMsg.createdAt) : null;
                    let showDateHeader =
                      !prevDate ||
                      new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()).getTime() !==
                        new Date(prevDate.getFullYear(), prevDate.getMonth(), prevDate.getDate()).getTime();

                    return (
                      <motion.div key={msg._id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
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
                          onTouchStart={(e) => {
                            handleHoldStart(msg._id);
                            handleSwipeStart(e);
                          }}
                          onTouchMove={handleSwipeMove}
                          onTouchEnd={(e) => {
                            handleHoldEnd();
                            handleSwipeEnd(e, msg);
                          }}
                          onMouseDown={() => handleHoldStart(msg._id)}
                          onMouseUp={handleHoldEnd}
                        >
                          <div
                            className={`max-w-[70%] p-2 rounded-lg shadow-sm ${
                              msg.senderId === userId ? 'bg-green-500 text-white rounded-br-none' : 'bg-white text-black rounded-bl-none'
                            } transition-all ${selectedMessages.includes(msg._id) ? 'bg-opacity-50' : ''}`}
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    viewMessage(msg);
                                  }}
                                />
                                {msg.caption && (
                                  <p className="text-xs italic text-gray-300 max-w-[80%] p-2 border-b border-l border-r border-gray-300 rounded-b-lg break-words">
                                    {msg.caption}
                                  </p>
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
                                  <p className="text-xs italic text-gray-300 max-w-[80%] p-2 border-b border-l border-r border-gray-300 rounded-b-lg break-words">
                                    {msg.caption}
                                  </p>
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
                                  onClick={() => {
                                    setReplyTo(msg);
                                    scrollToMessage(msg._id);
                                    setShowMessageMenu(null);
                                  }}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaForward
                                  onClick={() => {
                                    forwardMessage(msg);
                                    setShowMessageMenu(null);
                                  }}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaCopy
                                  onClick={() => {
                                    copyMessage(msg);
                                    setShowMessageMenu(null);
                                  }}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaShare
                                  onClick={() => {
                                    shareMessage(msg);
                                    setShowMessageMenu(null);
                                  }}
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
                  <button onClick={() => setMediaPreview(null)} className="absolute top-2 right-2 bg-red-500 text-white p-1 rounded-full">
                    <FaTrash />
                  </button>
                </div>
              )}
              {replyTo && (
                <div className="bg-gray-100 p-2 mb-2 rounded w-full max-w-[80%] mx-auto flex justify-between items-center">
                  <div>
                    <p className="text-xs italic text-gray-700">Replying to:</p>
                    <p className="text-sm">
                      {replyTo.contentType === 'text' ? replyTo.content.slice(0, 20) + (replyTo.content.length > 20 ? '...' : '') : replyTo.contentType}
                    </p>
                  </div>
                  <button onClick={() => setReplyTo(null)} className="text-red-500">
                    <FaTrash />
                  </button>
                </div>
              )}
              <div className="flex items-center">
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }} className="relative">
                  <FaPaperclip onClick={() => setShowPicker(!showPicker)} className="text-xl text-primary cursor-pointer hover:text-secondary mr-2" />
                  {showPicker && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      className="absolute bottom-12 left-0 bg-white p-2 rounded-lg shadow-lg z-20 flex space-x-2"
                    >
                      <label className="cursor-pointer">
                        <FaFileAlt className="text-blue-600" />
                        <input type="file" accept=".pdf,.doc,.docx" onChange={(e) => handleFileChange(e, 'document')} className="hidden" />
                      </label>
                      <label className="cursor-pointer">
                        <FaPlay className="text-green-500" />
                        <input type="file" accept="audio/*" onChange={(e) => handleFileChange(e, 'audio')} className="hidden" />
                      </label>
                      <label className="cursor-pointer">
                        <img src="https://placehold.co/20x20" alt="Image" />
                        <input type="file" accept="image/*" onChange={(e) => handleFileChange(e, 'image')} className="hidden" />
                      </label>
                      <label className="cursor-pointer">
                        <video width="20" height="20" />
                        <input type="file" accept="video/*" onChange={(e) => handleFileChange(e, 'video')} className="hidden" />
                      </label>
                    </motion.div>
                  )}
                </motion.div>
                <input
                  type="text"
                  value={message}
                  onChange={handleTyping}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder="Type a message..."
                  className="flex-1 p-2 border rounded-lg mr-2"
                  disabled={contentType !== 'text' && file}
                />
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaPaperPlane onClick={sendMessage} className="text-xl text-primary cursor-pointer hover:text-secondary" />
                </motion.div>
              </div>
              {uploadProgress !== null && (
                <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                  <div className="bg-primary h-2 rounded-full" style={{ width: `${uploadProgress}%` }}></div>
                </div>
              )}
              {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
            </div>
            {showJumpToBottom && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="fixed bottom-20 md:left-[66%] left-1/2 transform -translate-x-1/2 bg-primary text-white p-2 rounded-full cursor-pointer z-40"
                onClick={jumpToBottom}
              >
                <FaArrowDown />
              </motion.div>
            )}
            {showDeleteConfirm && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
              >
                <div className="bg-white p-6 rounded-lg shadow-lg">
                  <p className="mb-4">Are you sure you want to delete {selectedMessages.length} message(s)?</p>
                  <div className="flex justify-end space-x-2">
                    <button onClick={() => setShowDeleteConfirm(false)} className="bg-gray-300 text-black p-2 rounded-lg">
                      Cancel
                    </button>
                    <button onClick={deleteMessages} className="bg-red-500 text-white p-2 rounded-lg">
                      Delete
                    </button>
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
                    <a href={viewMedia.url} download target="_blank" rel="noopener noreferrer" className="text-blue-600">
                      Download Document
                    </a>
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