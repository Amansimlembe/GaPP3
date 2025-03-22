import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { motion } from 'framer-motion';
import { FaPaperPlane, FaPaperclip } from 'react-icons/fa';

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
  const [sending, setSending] = useState(null);
  const chatRef = useRef(null);

  useEffect(() => {
    if (!userId) return;
    socket.emit('join', userId);

    const fetchUsers = async () => {
      try {
        const { data } = await axios.get('/social/feed', { headers: { Authorization: `Bearer ${token}` } });
        setUsers([...new Set(data.map(post => post.userId).filter(id => id !== userId))]);
      } catch (error) {
        console.error('Failed to fetch users:', error);
      }
    };
    fetchUsers();

    const fetchMessages = async () => {
      try {
        const { data } = await axios.get('/social/messages', {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId: selectedUser },
        });
        setMessages(data);
        chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
      } catch (error) {
        console.error('Failed to fetch messages:', error);
      }
    };
    if (selectedUser) fetchMessages();

    socket.on('message', (msg) => {
      if ((msg.senderId === userId && msg.recipientId === selectedUser) || (msg.senderId === selectedUser && msg.recipientId === userId)) {
        setMessages((prev) => {
          const exists = prev.some(m => m._id === msg._id);
          const updated = exists ? prev : [...prev, msg];
          chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
          return updated;
        });
      }
    });

    return () => socket.off('message');
  }, [token, userId, selectedUser]);

  const sendMessage = async () => {
    if (!selectedUser || (!message && !file && contentType === 'text')) return;
    const formData = new FormData();
    formData.append('senderId', userId);
    formData.append('recipientId', selectedUser);
    formData.append('contentType', contentType);
    formData.append('caption', caption);
    if (file) formData.append('content', file);
    else formData.append('content', message);

    const tempId = Date.now();
    if (file) {
      setSending({ _id: tempId, senderId: userId, recipientId: selectedUser, contentType, content: URL.createObjectURL(file), caption });
      setMessages((prev) => [...prev, sending]);
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
    }

    try {
      const { data } = await axios.post('/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      socket.emit('message', data);
      setMessages((prev) => prev.map(msg => msg._id === tempId ? data : msg));
      setMessage('');
      setFile(null);
      setCaption('');
      setShowPicker(false);
      setSending(null);
    } catch (error) {
      console.error('Send message error:', error);
      setMessages((prev) => prev.filter(msg => msg._id !== tempId));
      setSending(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="flex h-screen p-4 flex-col bg-gray-100"
    >
      <div className="w-full bg-white p-4 rounded-lg shadow-md mb-4 overflow-x-auto flex space-x-2">
        {users.map((id) => (
          <motion.button
            key={id}
            whileHover={{ scale: 1.05 }}
            onClick={() => setSelectedUser(id)}
            className="p-2 bg-primary text-white rounded-full shadow hover:bg-secondary transition duration-300 whitespace-nowrap"
          >
            {id}
          </motion.button>
        ))}
      </div>
      <div className="w-full bg-white p-4 rounded-lg shadow-md flex flex-col h-full">
        {selectedUser ? (
          <>
            <motion.h2
              initial={{ y: -20 }}
              animate={{ y: 0 }}
              className="text-xl font-bold text-primary mb-4"
            >
              Chat with {selectedUser}
            </motion.h2>
            <div ref={chatRef} className="flex-1 overflow-y-auto mb-4 space-y-2">
              {messages.map((msg) => (
                <motion.div
                  key={msg._id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className={`mb-2 ${msg.senderId === userId ? 'text-right' : 'text-left'}`}
                >
                  <div className={`inline-block p-3 rounded-lg shadow ${msg.senderId === userId ? 'bg-primary text-white' : 'bg-gray-200 text-black'}`}>
                    {msg.contentType === 'text' && <p>{msg.content}</p>}
                    {msg.contentType === 'image' && <img src={msg.content} alt="Chat" className="max-w-xs rounded" />}
                    {msg.contentType === 'video' && <video controls src={msg.content} className="max-w-xs rounded" />}
                    {msg.contentType === 'audio' && <audio controls src={msg.content} />}
                    {msg.contentType === 'raw' && <a href={msg.content} target="_blank" rel="noopener noreferrer" className="text-blue-500">Download</a>}
                    {msg.caption && <p className="text-sm mt-1 italic">{msg.caption}</p>}
                  </div>
                </motion.div>
              ))}
            </div>
            <motion.div
              initial={{ y: 20 }}
              animate={{ y: 0 }}
              className="relative flex items-center"
            >
              {showPicker && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="absolute bottom-12 left-0 bg-white p-2 rounded-lg shadow-lg flex space-x-2"
                >
                  {['image', 'video', 'audio', 'raw', 'contact'].map((type) => (
                    <motion.button
                      key={type}
                      whileHover={{ scale: 1.1 }}
                      onClick={() => { setContentType(type); setShowPicker(false); }}
                      className="p-2 bg-primary text-white rounded hover:bg-secondary transition duration-300"
                    >
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </motion.button>
                  ))}
                </motion.div>
              )}
              {contentType === 'text' || contentType === 'contact' ? (
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="flex-1 p-3 border rounded-full pr-16 focus:ring-2 focus:ring-primary shadow-sm"
                  placeholder="Type a message"
                />
              ) : (
                <div className="flex-1 flex flex-col p-2 border rounded-lg shadow-sm">
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
                className="absolute right-8 text-xl text-primary cursor-pointer hover:text-secondary transition duration-200"
                onClick={() => setShowPicker(!showPicker)}
              />
              <FaPaperPlane
                className="absolute right-3 text-xl text-primary cursor-pointer hover:text-secondary transition duration-200"
                onClick={sendMessage}
              />
            </motion.div>
          </>
        ) : (
          <p className="text-gray-600 flex-1 flex items-center justify-center">Select a user to chat</p>
        )}
      </div>
    </motion.div>
  );
};

export default ChatScreen;