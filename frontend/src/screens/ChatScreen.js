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

    const tempId = Date.now(); // Temporary ID for loading state
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
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="flex h-screen p-4 flex-col">
      <div className="w-full bg-white p-4 rounded-lg shadow-md mb-4 overflow-x-auto flex space-x-2">
        {users.map((id) => (
          <button key={id} onClick={() => setSelectedUser(id)} className="p-2 hover:bg-gray-200 rounded whitespace-nowrap">{id}</button>
        ))}
      </div>
      <div className="w-full bg-white p-4 rounded-lg shadow-md flex flex-col h-full">
        {selectedUser ? (
          <>
            <h2 className="text-xl font-bold text-primary mb-4">Chat with {selectedUser}</h2>
            <div ref={chatRef} className="flex-1 overflow-y-auto mb-4">
              {messages.map((msg) => (
                <div key={msg._id} className={`mb-2 ${msg.senderId === userId ? 'text-right' : 'text-left'}`}>
                  <div className={`inline-block p-2 rounded-lg ${msg.senderId === userId ? 'bg-primary text-white' : 'bg-gray-200 text-black'}`}>
                    {msg.contentType === 'text' && <p>{msg.content}</p>}
                    {msg.contentType === 'image' && <img src={msg.content} alt="Chat" className="max-w-xs" />}
                    {msg.contentType === 'video' && <video controls src={msg.content} className="max-w-xs" />}
                    {msg.contentType === 'audio' && <audio controls src={msg.content} />}
                    {msg.contentType === 'raw' && <a href={msg.content} target="_blank" rel="noopener noreferrer" className="text-blue-500">Download</a>}
                    {msg.caption && <p className="text-sm mt-1">{msg.caption}</p>}
                  </div>
                </div>
              ))}
            </div>
            <div className="relative flex items-center">
              {showPicker && (
                <div className="absolute bottom-12 left-0 bg-white p-2 rounded-lg shadow-lg flex space-x-2">
                  {['image', 'video', 'audio', 'raw', 'contact'].map((type) => (
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
              {contentType === 'text' || contentType === 'contact' ? (
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="flex-1 p-2 border rounded-lg pr-16"
                  placeholder="Type a message"
                />
              ) : (
                <div className="flex-1 flex items-center p-2 border rounded-lg pr-16">
                  <input
                    type="file"
                    accept={contentType === 'image' ? 'image/*' : contentType === 'video' ? 'video/*' : contentType === 'audio' ? 'audio/*' : '*/*'}
                    onChange={(e) => setFile(e.target.files[0])}
                    className="flex-1"
                  />
                  <input
                    type="text"
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    className="w-full p-2 mt-2 border rounded-lg"
                    placeholder="Add a caption (optional)"
                  />
                </div>
              )}
              <FaPaperclip
                className="absolute right-8 text-xl text-primary cursor-pointer hover:text-secondary"
                onClick={() => setShowPicker(!showPicker)}
              />
              <FaPaperPlane
                className="absolute right-2 text-xl text-primary cursor-pointer hover:text-secondary"
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