import React, { useState, useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { motion } from 'framer-motion';
import { FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply } from 'react-icons/fa';

const socket = io('https://gapp-6yc3.onrender.com');

const ChatScreen = ({ token, userId }) => {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [file, setFile] = useState(null);
  const [caption, setCaption] = useState('');
  const [contentType, setContentType] = useState('text');
  const [showPicker, setShowPicker] = useState(false);
  const [notifications, setNotifications] = useState({});
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [viewMedia, setViewMedia] = useState(null);
  const [typing, setTyping] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const chatRef = useRef(null);
  const observerRef = useRef(null);

  useEffect(() => {
    if (!userId) return;
    socket.emit('join', userId);

    const fetchUsers = async () => {
      try {
        const { data } = await axios.get('/social/feed', { headers: { Authorization: `Bearer ${token}` } });
        const uniqueUsers = [...new Set(data.map(post => ({
          id: post.userId,
          username: post.username || localStorage.getItem('username') || 'Unknown',
          photo: post.photo || 'https://via.placeholder.com/40',
        })))].filter(u => u.id !== userId);
        setUsers(uniqueUsers);
      } catch (error) {
        console.error('Failed to fetch users:', error);
      }
    };
    fetchUsers();

    const fetchMessages = async () => {
      try {
        const { data } = await axios.get('/social/messages', {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId: selectedUser, limit: 20 },
        });
        setMessages(data.map(msg => ({ ...msg, status: msg.status || 'sent' })));
        chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
        setNotifications((prev) => ({ ...prev, [selectedUser]: 0 }));
      } catch (error) {
        console.error('Failed to fetch messages:', error);
      }
    };
    if (selectedUser) fetchMessages();

    socket.on('message', (msg) => {
      if ((msg.senderId === userId && msg.recipientId === selectedUser) || (msg.senderId === selectedUser && msg.recipientId === userId)) {
        setMessages((prev) => {
          const exists = prev.some(m => m._id === msg._id);
          const updated = exists ? prev.map(m => m._id === msg._id ? msg : m) : [...prev, msg];
          chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
          return updated;
        });
      } else if (msg.recipientId === userId) {
        setNotifications((prev) => ({ ...prev, [msg.senderId]: (prev[msg.senderId] || 0) + 1 }));
      }
    });

    socket.on('typing', ({ userId: typer, recipientId }) => {
      if (recipientId === userId && typer === selectedUser) setIsTyping((prev) => ({ ...prev, [typer]: true }));
    });

    socket.on('stopTyping', ({ userId: typer, recipientId }) => {
      if (recipientId === userId && typer === selectedUser) setIsTyping((prev) => ({ ...prev, [typer]: false }));
    });

    socket.on('messageStatus', ({ messageId, status }) => {
      setMessages((prev) => prev.map(msg => msg._id === messageId ? { ...msg, status } : msg));
    });

    return () => {
      socket.off('message');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
    };
  }, [token, userId, selectedUser]);

  const loadMoreMessages = useCallback(async () => {
    if (!selectedUser || messages.length < 20) return;
    try {
      const { data } = await axios.get('/social/messages', {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, recipientId: selectedUser, limit: 20, skip: messages.length },
      });
      setMessages((prev) => [...data.reverse(), ...prev]);
    } catch (error) {
      console.error('Failed to load more messages:', error);
    }
  }, [token, userId, selectedUser, messages.length]);

  useEffect(() => {
    if (!chatRef.current || !selectedUser) return;
    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreMessages();
      },
      { root: chatRef.current, threshold: 0.1 }
    );
    const firstMessage = chatRef.current.querySelector('.message:first-child');
    if (firstMessage) observerRef.current.observe(firstMessage);
    return () => observerRef.current?.disconnect();
  }, [loadMoreMessages, selectedUser]);

  const sendMessage = async () => {
    if (!selectedUser || (!message && !file && contentType === 'text')) return;
    socket.emit('stopTyping', { userId, recipientId: selectedUser });
    setTyping(false);

    const formData = new FormData();
    formData.append('senderId', userId);
    formData.append('recipientId', selectedUser);
    formData.append('contentType', contentType);
    formData.append('caption', caption);
    if (file) formData.append('content', file);
    else formData.append('content', message);
    if (replyTo) formData.append('replyTo', replyTo._id);

    const tempId = Date.now();
    const tempMsg = {
      _id: tempId,
      senderId: userId,
      recipientId: selectedUser,
      contentType,
      content: file ? URL.createObjectURL(file) : message,
      caption,
      status: 'sent',
      replyTo,
    };
    setMessages((prev) => [...prev, tempMsg]);
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });

    try {
      if (file) setUploadProgress(0);
      const { data } = await axios.post('/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
        onUploadProgress: (progressEvent) => {
          if (file) setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total));
        },
      });
      socket.emit('message', { ...data, status: 'sent' });
      setMessages((prev) => prev.map(msg => msg._id === tempId ? { ...data, status: 'sent' } : msg));
      setMessage('');
      setFile(null);
      setCaption('');
      setContentType('text');
      setShowPicker(false);
      setUploadProgress(null);
      setReplyTo(null);
      socket.emit('messageStatus', { messageId: data._id, status: 'delivered', recipientId: selectedUser });
    } catch (error) {
      console.error('Send message error:', error);
      setMessages((prev) => prev.filter(msg => msg._id !== tempId));
      setUploadProgress(null);
    }
  };

  const handleTyping = () => {
    if (!typing) {
      socket.emit('typing', { userId, recipientId: selectedUser });
      setTyping(true);
    }
    setTimeout(() => {
      socket.emit('stopTyping', { userId, recipientId: selectedUser });
      setTyping(false);
    }, 2000);
  };

  const deleteMessage = async (messageId) => {
    try {
      await axios.delete(`/social/message/${messageId}`, { headers: { Authorization: `Bearer ${token}` } });
      setMessages(messages.filter(msg => msg._id !== messageId));
      setSelectedMessage(null);
    } catch (error) {
      console.error('Delete message error:', error);
    }
  };

  const viewMessage = (msg) => {
    if (msg.senderId !== userId && msg.status === 'delivered') {
      socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
    }
    setViewMedia(msg.content);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="flex flex-col h-screen bg-gray-100">
      {!selectedUser ? (
        <div className="flex-1 overflow-y-auto">
          {users.map((user) => (
            <motion.div
              key={user.id}
              whileHover={{ backgroundColor: '#f0f0f0' }}
              onClick={() => setSelectedUser(user.id)}
              className="flex items-center p-3 border-b border-gray-200 cursor-pointer"
            >
              <img src={user.photo} alt="Profile" className="w-12 h-12 rounded-full mr-3" />
              <span className="font-semibold">{user.username}</span>
              {notifications[user.id] > 0 && (
                <span className="ml-auto bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {notifications[user.id]}
                </span>
              )}
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col flex-1">
          <div className="bg-white p-3 flex items-center border-b border-gray-200">
            <FaArrowLeft onClick={() => setSelectedUser(null)} className="text-xl text-primary cursor-pointer mr-3 hover:text-secondary" />
            <img src={users.find(u => u.id === selectedUser)?.photo} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
            <span className="font-semibold">{users.find(u => u.id === selectedUser)?.username}</span>
          </div>
          <div ref={chatRef} className="flex-1 overflow-y-auto bg-gray-50">
            {messages.map((msg) => (
              <motion.div
                key={msg._id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`message p-2 ${msg.senderId === userId ? 'text-right' : 'text-left'}`}
              >
                {msg.replyTo && (
                  <div className="bg-gray-200 p-2 rounded mb-1 text-sm italic">
                    <p>Replying to: {msg.replyTo.content.slice(0, 20)}...</p>
                  </div>
                )}
                <div
                  className={`inline-block p-2 rounded-lg ${msg.senderId === userId ? 'bg-primary text-white' : 'bg-white text-black'} shadow`}
                  onClick={() => setSelectedMessage(msg._id === selectedMessage ? null : msg._id)}
                >
                  {msg.contentType === 'text' && <p>{msg.content}</p>}
                  {msg.contentType === 'image' && <img src={msg.content} alt="Chat" className="max-w-full w-auto h-auto rounded cursor-pointer" onClick={(e) => e.stopPropagation() || viewMessage(msg)} />}
                  {msg.contentType === 'video' && <video src={msg.content} controls className="max-w-full w-auto h-auto rounded cursor-pointer" onClick={(e) => e.stopPropagation() || viewMessage(msg)} />}
                  {msg.contentType === 'audio' && <audio src={msg.content} controls className="w-full" />}
                  {msg.contentType === 'raw' && <a href={msg.content} target="_blank" rel="noopener noreferrer" className="text-blue-500">Download</a>}
                  {msg.caption && <p className="text-sm mt-1 italic max-w-full">{msg.caption}</p>}
                  {msg.senderId === userId && (
                    <span className="text-xs flex justify-end">
                      {msg.status === 'sent' && '✓'}
                      {msg.status === 'delivered' && '✓✓'}
                      {msg.status === 'read' && <span className="text-green-500">✅✅</span>}
                    </span>
                  )}
                  {msg._id === uploadProgress?._id && uploadProgress !== null && (
                    <div className="text-xs">Uploading: {uploadProgress}%</div>
                  )}
                </div>
                {msg._id === selectedMessage && (
                  <div className="flex justify-end mt-1">
                    <FaReply onClick={() => setReplyTo(msg)} className="text-primary cursor-pointer hover:text-secondary mr-2" />
                    {msg.senderId === userId && (
                      <FaTrash onClick={() => deleteMessage(msg._id)} className="text-red-500 cursor-pointer hover:text-red-700" />
                    )}
                  </div>
                )}
              </motion.div>
            ))}
            {isTyping[selectedUser] && <p className="text-sm text-gray-500 p-2">User is typing...</p>}
          </div>
          <motion.div initial={{ y: 20 }} animate={{ y: 0 }} className="bg-white p-2 flex items-center">
            {replyTo && (
              <div className="bg-gray-100 p-2 mb-2 rounded w-full">
                <p className="text-sm italic">Replying to: {replyTo.content.slice(0, 20)}...</p>
                <button onClick={() => setReplyTo(null)} className="text-red-500 text-xs">Cancel</button>
              </div>
            )}
            {contentType === 'text' ? (
              <input
                value={message}
                onChange={(e) => { setMessage(e.target.value); handleTyping(); }}
                className="flex-1 p-2 border rounded-full focus:ring-2 focus:ring-primary"
                placeholder="Type a message"
              />
            ) : (
              <div className="flex-1 flex flex-col p-2 border rounded-lg">
                <input
                  type="file"
                  accept={contentType === 'image' ? 'image/*' : contentType === 'video' ? 'video/*' : contentType === 'audio' ? 'audio/*' : '*/*'}
                  onChange={(e) => setFile(e.target.files[0])}
                  className="flex-1 mb-2"
                />
                <input
                  type="text"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-primary"
                  placeholder="Add a caption (optional)"
                />
              </div>
            )}
            <FaPaperclip
              className="mx-2 text-xl text-primary cursor-pointer hover:text-secondary"
              onClick={() => setShowPicker(!showPicker)}
            />
            <FaPaperPlane
              className="text-xl text-primary cursor-pointer hover:text-secondary"
              onClick={sendMessage}
            />
            {showPicker && (
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                className="absolute bottom-16 left-2 bg-white p-2 rounded-lg shadow-lg flex space-x-2"
              >
                {['image', 'video', 'audio', 'raw'].map((type) => (
                  <motion.button
                    key={type}
                    whileHover={{ scale: 1.1 }}
                    onClick={() => { setContentType(type); setShowPicker(false); }}
                    className="p-2 bg-primary text-white rounded hover:bg-secondary"
                  >
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </motion.button>
                ))}
              </motion.div>
            )}
          </motion.div>
        </div>
      )}
      {viewMedia && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 bg-black flex items-center justify-center z-50"
          onClick={() => setViewMedia(null)}
        >
          <FaArrowLeft
            onClick={(e) => { e.stopPropagation(); setViewMedia(null); }}
            className="absolute top-4 left-4 text-white text-2xl cursor-pointer hover:text-primary"
          />
          {contentType === 'image' && <img src={viewMedia} alt="Full" className="max-w-full max-h-full object-contain cursor-grab" />}
          {contentType === 'video' && <video controls src={viewMedia} className="max-w-full max-h-full object-contain cursor-grab" />}
          {contentType === 'audio' && <audio controls src={viewMedia} className="w-full" />}
        </motion.div>
      )}
    </motion.div>
  );
};

export default ChatScreen;