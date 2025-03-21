import React, { useState, useEffect } from 'react';
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
  const [contentType, setContentType] = useState('text');
  const [showPicker, setShowPicker] = useState(false);

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
      } catch (error) {
        console.error('Failed to fetch messages:', error);
      }
    };
    if (selectedUser) fetchMessages();

    socket.on('message', (msg) => {
      if ((msg.senderId === userId && msg.recipientId === selectedUser) || (msg.senderId === selectedUser && msg.recipientId === userId)) {
        setMessages((prev) => {
          const exists = prev.some(m => m._id === msg._id);
          return exists ? prev : [...prev, msg];
        });
      }
    });

    return () => socket.off('message');
  }, [token, userId, selectedUser]);

  const sendMessage = async () => {
    if (!selectedUser || (!message && !file)) return;
    const formData = new FormData();
    formData.append('senderId', userId);
    formData.append('recipientId', selectedUser);
    formData.append('contentType', contentType);
    if (file) formData.append('content', file);
    else formData.append('content', message);

    try {
      const { data } = await axios.post('/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      socket.emit('message', data);
      setMessages((prev) => [...prev, data]);
      setMessage('');
      setFile(null);
      setShowPicker(false);
    } catch (error) {
      console.error('Send message error:', error);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="flex h-screen p-4 md:p-6 flex-col md:flex-row">
      <div className="w-full md:w-1/4 bg-white p-4 rounded-lg shadow-md mb-4 md:mb-0">
        <h2 className="text-xl font-bold text-primary mb-4">Users</h2>
        {users.map((id) => (
          <button key={id} onClick={() => setSelectedUser(id)} className="block w-full text-left p-2 hover:bg-gray-200 rounded">{id}</button>
        ))}
      </div>
      <div className="w-full md:w-3/4 md:ml-4 bg-white p-4 rounded-lg shadow-md flex flex-col h-full">
        {selectedUser ? (
          <>
            <h2 className="text-xl font-bold text-primary mb-4">Chat with {selectedUser}</h2>
            <div className="flex-1 overflow-y-auto mb-4">
              {messages.map((msg) => (
                <div key={msg._id} className={`mb-2 ${msg.senderId === userId ? 'text-right' : 'text-left'}`}>
                  <div className={`inline-block p-2 rounded-lg ${msg.senderId === userId ? 'bg-primary text-white' : 'bg-gray-200 text-black'}`}>
                    {msg.contentType === 'text' && <p>{msg.content}</p>}
                    {msg.contentType === 'image' && <img src={msg.content} alt="Chat" className="max-w-xs" />}
                    {msg.contentType === 'video' && <video controls src={msg.content} className="max-w-xs" />}
                    {msg.contentType === 'audio' && <audio controls src={msg.content} />}
                    {msg.contentType === 'raw' && <a href={msg.content} target="_blank" rel="noopener noreferrer" className="text-blue-500">Download</a>}
                  </div>
                </div>
              ))}
            </div>
            <div className="relative flex items-center">
              {showPicker && (
                <div className="absolute bottom-12 left-0 bg-white p-2 rounded-lg shadow-lg flex space-x-2">
                  {['image', 'video', 'audio', 'raw'].map((type) => (
                    <button
                      key={type}
                      onClick={() => { setContentType(type); setShowPicker(false); }}
                      className="p-2 hover:bg-gray-200 rounded"
                    >
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </button>
                  ))}
                </div>
              )}
              {contentType === 'text' ? (
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="flex-1 p-2 border rounded-lg mr-2"
                  placeholder="Type a message"
                />
              ) : (
                <input
                  type="file"
                  accept={contentType === 'image' ? 'image/*' : contentType === 'video' ? 'video/*' : contentType === 'audio' ? 'audio/*' : '*/*'}
                  onChange={(e) => setFile(e.target.files[0])}
                  className="flex-1 p-2 border rounded-lg mr-2"
                />
              )}
              <FaPaperclip
                className="text-2xl text-primary cursor-pointer hover:text-secondary mr-2"
                onClick={() => setShowPicker(!showPicker)}
              />
              <FaPaperPlane
                className="text-2xl text-primary cursor-pointer hover:text-secondary"
                onClick={sendMessage}
              />
            </div>
          </>
        ) : (
          <p className="text-gray-600 flex-1 flex items-center justify-center">Select a user to chat</p>
        )}
      </div>
    </motion.div>
  );
};

export default ChatScreen;