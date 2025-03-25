import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply, FaEllipsisH, FaSave, FaShare, FaCopy, FaForward, FaFileAlt, FaPlay, FaArrowDown, FaDownload } from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import { setMessages, addMessage, updateMessageStatus, setSelectedChat } from '../store';
import { saveMessages, getMessages } from '../db';

const socket = io('https://gapp-6yc3.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
});

const ChatScreen = ({ token, userId }) => {
  const dispatch = useDispatch();
  const { chats, selectedChat } = useSelector((state) => state.messages);
  const [users, setUsers] = useState([]);
  const [message, setMessage] = useState('');
  const [file, setFile] = useState(null);
  const [caption, setCaption] = useState('');
  const [contentType, setContentType] = useState('text');
  const [showPicker, setShowPicker] = useState(false);
  const [notifications, setNotifications] = useState({});
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [viewMedia, setViewMedia] = useState(null);
  const [typing, setTyping] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [newContact, setNewContact] = useState('');
  const [error, setError] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [hoveredMessage, setHoveredMessage] = useState(null);
  const [showMessageMenu, setShowMessageMenu] = useState(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [mediaPreview, setMediaPreview] = useState(null);
  const [holdTimer, setHoldTimer] = useState(null);
  const [swipeStartX, setSwipeStartX] = useState(null);
  const [page, setPage] = useState(0); // Track the current page for pagination
  const [hasMore, setHasMore] = useState(true); // Track if there are more messages to load
  const [loading, setLoading] = useState(false); // Track loading state for fetching messages
  const chatRef = useRef(null);
  const menuRef = useRef(null);
  const messageMenuRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  const messagesPerPage = 50; // Number of messages to fetch per page
  const isSmallDevice = window.innerWidth < 768;

  // Helper function to format the date for grouping (e.g., "Today", "Yesterday", or "March 24, 2025")
  const formatDateHeader = (date) => {
    const today = new Date();
    const messageDate = new Date(date);

    // Reset time for comparison (only compare dates)
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const messageDateOnly = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());

    const diffTime = todayDate - messageDateOnly;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'Today';
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else {
      return messageDate.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
    }
  };

  // Helper function to format the time in 12-hour format (e.g., "10:28 PM")
  const formatTime = (date) => {
    return new Date(date).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  useEffect(() => {
    if (!userId || !token) return;

    socket.emit('join', userId);

    const keepAlive = setInterval(() => {
      socket.emit('ping', { userId });
    }, 300000); // Ping every 5 minutes

    const fetchUsers = async () => {
      try {
        const { data } = await axios.get('/auth/contacts', { headers: { Authorization: `Bearer ${token}` } });
        setUsers(data);
      } catch (error) {
        setError('Failed to load contacts');
      }
    };
    fetchUsers();

    const loadOfflineMessages = async () => {
      const offlineMessages = await getMessages();
      if (offlineMessages.length > 0) {
        offlineMessages.forEach((msg) => {
          const chatId = msg.recipientId === userId ? msg.senderId : msg.recipientId;
          dispatch(addMessage({ recipientId: chatId, message: msg }));
        });
      }
    };
    loadOfflineMessages();

    const fetchMessages = async (pageNum = 0, isInitialLoad = true) => {
      if (!selectedChat || loading) return;
      setLoading(true);
      try {
        const { data } = await axios.get('/social/messages', {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId: selectedChat, limit: messagesPerPage, skip: pageNum * messagesPerPage },
        });
        console.log('Fetched messages:', data);
        // Backend returns messages in descending order (newest to oldest), reverse for display (oldest to newest)
        let messages = data.messages.map((msg) => ({ ...msg, status: msg.status || 'sent' })).reverse();

        // Merge with offline messages
        const offlineMessages = await getMessages();
        const offlineChatMessages = offlineMessages
          .filter((msg) => {
            const chatId = msg.recipientId === userId ? msg.senderId : msg.recipientId;
            return chatId === selectedChat;
          })
          .map((msg) => ({ ...msg, status: msg.status || 'sent' }));

        // Combine fetched and offline messages, removing duplicates
        const allMessages = [...messages, ...offlineChatMessages].reduce((acc, msg) => {
          if (!acc.some((m) => m._id === msg._id)) {
            acc.push(msg);
          }
          return acc;
        }, []);

        // Sort messages by createdAt (oldest to newest) for display
        allMessages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        // Use hasMore from the backend response
        setHasMore(data.hasMore);

        if (isInitialLoad) {
          dispatch(setMessages({ recipientId: selectedChat, messages: allMessages }));
          setNotifications((prev) => ({ ...prev, [selectedChat]: 0 }));

          const lastReadIndex = allMessages.findIndex((msg) => msg.recipientId === userId && msg.status === 'read');
          const unreadMessages = allMessages.slice(lastReadIndex + 1).filter((msg) => msg.recipientId === userId);
          setUnreadCount(unreadMessages.length);
          if (unreadMessages.length > 0) {
            setFirstUnreadMessageId(unreadMessages[0]._id);
          }

          if (unreadMessages.length === 0) {
            chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
          } else {
            const firstUnreadElement = document.getElementById(`message-${unreadMessages[0]._id}`);
            if (firstUnreadElement) {
              firstUnreadElement.scrollIntoView({ behavior: 'smooth' });
            }
          }
        } else {
          // Prepend older messages for infinite scroll
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

    // Fetch initial messages when selectedChat changes
    if (selectedChat) {
      setPage(0);
      setHasMore(true);
      fetchMessages(0, true);
    }

    socket.on('message', (msg) => {
      saveMessages([msg]);
      const senderKnown = users.some((u) => u.id === msg.senderId);
      let updatedMsg = { ...msg, username: senderKnown ? msg.senderUsername : 'Unsaved Number' };

      const chatId = msg.senderId === userId ? msg.recipientId : msg.senderId;

      const existingMessage = (chats[chatId] || []).find((m) => m._id === msg._id);
      if (!existingMessage) {
        dispatch(addMessage({ recipientId: chatId, message: updatedMsg }));
      }

      if (msg.recipientId === userId && !senderKnown) {
        setUsers((prev) => [
          ...prev,
          { id: msg.senderId, virtualNumber: msg.senderVirtualNumber, username: 'Unsaved Number', photo: msg.senderPhoto || 'https://placehold.co/40x40' },
        ]);
      }

      if ((msg.senderId === userId && msg.recipientId === selectedChat) || (msg.senderId === selectedChat && msg.recipientId === userId)) {
        if (msg.recipientId === userId) {
          setUnreadCount((prev) => prev + 1);
          if (!firstUnreadMessageId) {
            setFirstUnreadMessageId(msg._id);
            const firstUnreadElement = document.getElementById(`message-${msg._id}`);
            if (firstUnreadElement) {
              firstUnreadElement.scrollIntoView({ behavior: 'smooth' });
            }
          }
          socket.emit('messageStatus', { messageId: msg._id, status: 'delivered', recipientId: userId });
          socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
        }
        chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
      } else if (msg.recipientId === userId) {
        setNotifications((prev) => ({ ...prev, [msg.senderId]: (prev[msg.senderId] || 0) + 1 }));
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
    });

    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setShowMenu(false);
      if (messageMenuRef.current && !messageMenuRef.current.contains(event.target)) setShowMessageMenu(null);
    };
    document.addEventListener('mousedown', handleClickOutside);

    const handleScroll = () => {
      if (chatRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
        if (scrollHeight - scrollTop - clientHeight > 100) {
          setShowJumpToBottom(true);
        } else {
          setShowJumpToBottom(false);
        }

        // Trigger fetching more messages when scrolling to the top
        if (scrollTop < 100 && hasMore && !loading) {
          setPage((prevPage) => prevPage + 1);
        }
      }
    };
    chatRef.current?.addEventListener('scroll', handleScroll);

    if (isSmallDevice) {
      const bottomNav = document.querySelector('.bottom-nav');
      if (bottomNav) bottomNav.style.zIndex = '10';
    }

    // Fetch more messages when page changes (for infinite scroll)
    if (page > 0) {
      fetchMessages(page, false);
    }

    return () => {
      socket.off('message');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
      document.removeEventListener('mousedown', handleClickOutside);
      chatRef.current?.removeEventListener('scroll', handleScroll);
      clearInterval(keepAlive);
    };
  }, [token, userId, selectedChat, page, dispatch]);

  const sendMessage = async () => {
    if (!selectedChat || (!message && !file && contentType === 'text')) {
      setError('Please enter a message or select a file');
      return;
    }

    socket.emit('stopTyping', { userId, recipientId: selectedChat });
    setTyping(false);

    const formData = new FormData();
    formData.append('senderId', userId);
    formData.append('recipientId', selectedChat);
    formData.append('contentType', contentType);
    formData.append('caption', caption);
    if (file) formData.append('content', file);
    else formData.append('content', message);
    if (replyTo) formData.append('replyTo', replyTo._id);

    const tempId = Date.now();
    const tempMsg = { _id: tempId, senderId: userId, recipientId: selectedChat, contentType, content: file ? URL.createObjectURL(file) : message, caption, status: 'sent', replyTo, createdAt: new Date() };
    dispatch(addMessage({ recipientId: selectedChat, message: tempMsg }));
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });

    try {
      if (file) setUploadProgress(0);
      const { data } = await axios.post('/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
        onUploadProgress: (progressEvent) => {
          if (file) setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total));
        },
      });
      console.log('Message sent to backend:', data);
      socket.emit('message', { ...data, senderVirtualNumber: localStorage.getItem('virtualNumber'), senderUsername: localStorage.getItem('username'), senderPhoto: localStorage.getItem('photo') });
      dispatch(setMessages({
        recipientId: selectedChat,
        messages: (chats[selectedChat] || []).map((msg) => (msg._id === tempId ? { ...data, status: 'sent' } : msg)),
      }));
      setMessage('');
      setFile(null);
      setCaption('');
      setContentType('text');
      setShowPicker(false);
      setUploadProgress(null);
      setReplyTo(null);
      setMediaPreview(null);
      setError('');
    } catch (error) {
      console.error('Send message error:', error);
      dispatch(setMessages({
        recipientId: selectedChat,
        messages: (chats[selectedChat] || []).filter((msg) => msg._id !== tempId),
      }));
      setUploadProgress(null);
      setError('Failed to send message');
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
            headers: { Authorization: `Bearer ${token}` }
          })
        )
      );
      dispatch(setMessages({
        recipientId: selectedChat,
        messages: (chats[selectedChat] || []).filter((msg) => !selectedMessages.includes(msg._id)),
      }));
      setSelectedMessages([]);
      setShowDeleteConfirm(false);
    } catch (error) {
      console.error('Delete message error:', error);
      setError('Failed to delete messages');
    }
  };

  const viewMessage = (msg) => {
    if (msg.senderId !== userId && msg.status === 'delivered') {
      socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
    }
    setViewMedia({ type: msg.contentType, url: msg.content });
  };

  const forwardMessage = async (msg) => {
    const recipientId = prompt('Enter the virtual number of the user to forward to:');
    if (!recipientId) return;
    const contact = users.find((u) => u.virtualNumber === recipientId);
    if (!contact) {
      setError('User not found');
      return;
    }

    const formData = new FormData();
    formData.append('senderId', userId);
    formData.append('recipientId', contact.id);
    formData.append('contentType', msg.contentType);
    formData.append('caption', msg.caption || '');
    formData.append('content', msg.content);

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
        text: msg.contentType === 'text' ? msg.content : msg.content,
        url: msg.contentType !== 'text' ? msg.content : undefined,
      });
    } else {
      alert('Sharing not supported on this device');
    }
  };

  const addContact = async () => {
    try {
      const { data } = await axios.post('/auth/add_contact', { userId, virtualNumber: newContact }, { headers: { Authorization: `Bearer ${token}` } });
      if (data.userId) {
        setUsers((prev) => [...prev, { id: data.userId, virtualNumber: newContact, username: data.username, photo: data.photo }]);
        setNewContact('');
        setShowMenu(false);
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
    }
    setSwipeStartX(null);
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
              <img src={user.photo || 'https://placehold.co/40x40'} alt="Profile" className="w-12 h-12 rounded-full mr-3" />
              <div className="flex-1">
                <span className="font-semibold">{user.virtualNumber}</span>
                <span className="text-sm ml-2 text-gray-600">{user.username || 'Unknown'}</span>
              </div>
              {notifications[user.id] > 0 && (
                <span className="ml-auto bg-green-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {notifications[user.id]}
                </span>
              )}
            </motion.div>
          ))}
        </div>
        {showMenu && (
          <motion.div
            ref={menuRef}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute top-16 right-4 bg-white p-4 rounded-lg shadow-lg z-10"
          >
            <input
              type="text"
              value={newContact}
              onChange={(e) => setNewContact(e.target.value)}
              className="w-full p-2 mb-2 border rounded-lg"
              placeholder="Enter virtual number"
            />
            <button onClick={addContact} className="flex items-center text-primary hover:text-secondary">
              <FaSave className="mr-1" /> Save
            </button>
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
                    onClick={() => {
                      dispatch(setSelectedChat(null));
                    }}
                    className="text-xl text-primary cursor-pointer mr-3 hover:text-secondary"
                  />
                </motion.div>
              )}
              <img src={users.find((u) => u.id === selectedChat)?.photo || 'https://placehold.co/40x40'} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
              <div>
                <span className="font-semibold">{users.find((u) => u.id === selectedChat)?.virtualNumber || 'Unknown'}</span>
                {isTyping[selectedChat] && <span className="text-sm text-green-500 ml-2">Typing...</span>}
              </div>
            </div>
            <div ref={chatRef} className="flex-1 overflow-y-auto bg-gray-100 p-2 pt-16 pb-32">
              {loading && page === 0 && (
                <div className="text-center py-2">
                  <p className="text-gray-500">Loading messages...</p>
                </div>
              )}
              {(chats[selectedChat] || []).length === 0 && !loading ? (
                <p className="text-center text-gray-500 mt-4">Start a new conversation</p>
              ) : (
                <>
                  {(chats[selectedChat] || []).map((msg, index) => {
                    const currentDate = new Date(msg.createdAt);
                    const prevMsg = index > 0 ? (chats[selectedChat] || [])[index - 1] : null;
                    const prevDate = prevMsg ? new Date(prevMsg.createdAt) : null;

                    // Determine if we need to show a date header
                    let showDateHeader = false;
                    if (!prevDate) {
                      showDateHeader = true; // Always show for the first message
                    } else {
                      const currentDateOnly = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
                      const prevDateOnly = new Date(prevDate.getFullYear(), prevDate.getMonth(), prevDate.getDate());
                      showDateHeader = currentDateOnly.getTime() !== prevDateOnly.getTime();
                    }

                    return (
                      <motion.div
                        key={msg._id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3 }}
                      >
                        {showDateHeader && (
                          <div className="text-center my-2">
                            <span className="bg-gray-300 text-gray-700 px-2 py-1 rounded-full text-sm">
                              {formatDateHeader(msg.createdAt)}
                            </span>
                          </div>
                        )}
                        {firstUnreadMessageId === msg._id && unreadCount > 0 && (
                          <div className="text-center my-2">
                            <span className="bg-blue-500 text-white px-2 py-1 rounded-full text-sm">
                              {unreadCount} Unread Messages
                            </span>
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    viewMessage(msg);
                                  }}
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                  }}
                                >
                                  <FaDownload />
                                </a>
                                {msg.caption && <p className="text-xs ml-2 italic text-gray-600">{msg.caption}</p>}
                              </div>
                            )}
                            <div className="flex justify-between items-center mt-1">
                              {msg.senderId === userId && (
                                <span className="text-xs">
                                  {msg.status === 'sent' && '✓'}
                                  {msg.status === 'delivered' && '✓✓'}
                                  {msg.status === 'read' && <span className="text-blue-500">✓✓</span>}
                                </span>
                              )}
                              <span className="text-xs text-gray-500">
                                {formatTime(msg.createdAt)}
                              </span>
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
                                  onClick={() => setReplyTo(msg)}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaForward
                                  onClick={() => forwardMessage(msg)}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaCopy
                                  onClick={() => copyMessage(msg)}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                <FaShare
                                  onClick={() => shareMessage(msg)}
                                  className="text-primary cursor-pointer hover:text-secondary"
                                />
                              </motion.div>
                              {msg.senderId === userId && (
                                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                                  <FaTrash
                                    onClick={() => {
                                      setSelectedMessages([msg._id]);
                                      setShowDeleteConfirm(true);
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
                    <div
                      className="bg-green-500 h-2.5 rounded-full"
                      style={{ width: `${uploadProgress}%` }}
                    ></div>
                  </div>
                  <p className="text-xs text-center mt-1">Uploading: {uploadProgress}%</p>
                </div>
              )}
              {selectedMessages.length > 0 && (
                <div className="flex items-center w-full mb-2">
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="bg-red-500 text-white px-3 py-1 rounded mr-2"
                  >
                    Delete ({selectedMessages.length})
                  </button>
                  <button
                    onClick={() => setSelectedMessages([])}
                    className="bg-gray-500 text-white px-3 py-1 rounded"
                  >
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
                        accept={
                          type === 'image'
                            ? 'image/*'
                            : type === 'video'
                            ? 'video/*'
                            : type === 'audio'
                            ? 'audio/*'
                            : '*/*'
                        }
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
              onClick={(e) => {
                e.stopPropagation();
                setViewMedia(null);
              }}
              className="absolute top-4 left-4 text-white text-2xl cursor-pointer hover:text-green-500"
            />
          </motion.div>
          {viewMedia.type === 'image' && (
            <img src={viewMedia.url} alt="Full" className="max-w-full max-h-full object-contain rounded-lg shadow-lg" />
          )}
          {viewMedia.type === 'video' && (
            <video
              controls
              autoPlay
              src={viewMedia.url}
              className="w-full h-full object-contain rounded-lg shadow-lg"
            />
          )}
          {viewMedia.type === 'audio' && <audio controls src={viewMedia.url} className="w-full" />}
          {viewMedia.type === 'document' && (
            <iframe src={viewMedia.url} className="w-full h-full rounded-lg" title="Document" />
          )}
        </motion.div>
      )}

      {showDeleteConfirm && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
        >
          <div className="bg-white p-4 rounded-lg shadow-lg">
            <p className="text-lg mb-4">Are you sure you want to delete {selectedMessages.length} message(s)?</p>
            <div className="flex justify-end space-x-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="bg-gray-500 text-white px-3 py-1 rounded"
              >
                Cancel
              </button>
              <button onClick={deleteMessages} className="bg-red-500 text-white px-3 py-1 rounded">
                Delete
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {error && <p className="text-red-500 text-center py-2 z-40 fixed top-0 w-full">{error}</p>}
    </motion.div>
  );
};

export default ChatScreen;