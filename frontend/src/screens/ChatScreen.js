import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply, FaEllipsisH, FaSave } from 'react-icons/fa';

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
  const [typing, setTyping] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [newContact, setNewContact] = useState('');
  const chatRef = useRef(null);

  useEffect(() => {
    if (!userId) return;
    socket.emit('join', userId);

    const fetchUsers = async () => {
      try {
        const { data } = await axios.get('/auth/contacts', { headers: { Authorization: `Bearer ${token}` } });
        setUsers(data);
      } catch (error) {
        console.error('Failed to fetch users:', error);
      }
    };
    fetchUsers();

    const fetchMessages = async () => {
      if (!selectedUser) return;
      try {
        const { data } = await axios.get('/social/messages', {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId: selectedUser },
        });
        setMessages(data.map(msg => ({ ...msg, status: msg.status || 'sent' })));
        chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
        setNotifications((prev) => ({ ...prev, [selectedUser]: 0 }));
      } catch (error) {
        console.error('Failed to fetch messages:', error);
      }
    };
    fetchMessages();

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
        if (!users.some(u => u.id === msg.senderId)) {
          setUsers((prev) => [...prev, { id: msg.senderId, virtualNumber: msg.senderVirtualNumber, username: msg.senderUsername, photo: msg.senderPhoto }]);
        }
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
    const tempMsg = { _id: tempId, senderId: userId, recipientId: selectedUser, contentType, content: file ? URL.createObjectURL(file) : message, caption, status: 'sent', replyTo };
    setMessages((prev) => [...prev, tempMsg]);
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });

    try {
      const { data } = await axios.post('/social/message', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      socket.emit('message', { ...data, senderVirtualNumber: localStorage.getItem('virtualNumber'), senderUsername: localStorage.getItem('username'), senderPhoto: localStorage.getItem('photo') });
      setMessages((prev) => prev.map(msg => msg._id === tempId ? { ...msg, ...data, status: 'sent' } : msg));
      setMessage('');
      setFile(null);
      setCaption('');
      setContentType('text');
      setShowPicker(false);
      setReplyTo(null);
      socket.emit('messageStatus', { messageId: data._id, status: 'delivered', recipientId: selectedUser });
    } catch (error) {
      console.error('Send message error:', error);
      setMessages((prev) => prev.filter(msg => msg._id !== tempId));
    }
  };

  const handleTyping = () => {
    if (!typing && selectedUser) {
      socket.emit('typing', { userId, recipientId: selectedUser });
      setTyping(true);
      setTimeout(() => {
        socket.emit('stopTyping', { userId, recipientId: selectedUser });
        setTyping(false);
      }, 2000);
    }
  };

  const addContact = async () => {
    try {
      const { data } = await axios.post('/auth/add_contact', { userId, virtualNumber: newContact }, { headers: { Authorization: `Bearer ${token}` } });
      if (data.userId) {
        setUsers((prev) => [...prev, { id: data.userId, virtualNumber: newContact, username: data.username, photo: data.photo }]);
        setNewContact('');
        setShowMenu(false);
      }
    } catch (error) {
      console.error('Add contact error:', error);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="flex flex-col h-screen bg-gray-100">
      {!selectedUser ? (
        <div className="flex-1 overflow-y-auto relative">
          <FaEllipsisH onClick={() => setShowMenu(true)} className="absolute top-4 right-4 text-2xl text-primary cursor-pointer hover:text-secondary" />
          {users.map((user) => (
            <motion.div
              key={user.id}
              whileHover={{ backgroundColor: '#f0f0f0' }}
              onClick={() => setSelectedUser(user.id)}
              className="flex items-center p-3 border-b border-gray-200 cursor-pointer"
            >
              <img src={user.photo || 'https://via.placeholder.com/40'} alt="Profile" className="w-12 h-12 rounded-full mr-3" />
              <div>
                <span className="font-semibold">{user.virtualNumber}</span>
                <span className="text-sm ml-2">{user.username || 'Unknown'}</span>
              </div>
              {notifications[user.id] > 0 && (
                <span className="ml-auto bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {notifications[user.id]}
                </span>
              )}
            </motion.div>
          ))}
          {showMenu && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="absolute top-12 right-4 bg-white dark:bg-gray-800 p-4 rounded-lg shadow-lg"
            >
              <input
                type="text"
                value={newContact}
                onChange={(e) => setNewContact(e.target.value)}
                className="w-full p-2 mb-2 border rounded-lg dark:bg-gray-700 dark:text-white"
                placeholder="Enter virtual number"
              />
              <button onClick={addContact} className="flex items-center text-primary hover:text-secondary">
                <FaSave className="mr-1" /> Save
              </button>
            </motion.div>
          )}
        </div>
      ) : (
        <div className="flex flex-col flex-1">
          <div className="bg-white p-3 flex items-center border-b border-gray-200">
            <FaArrowLeft onClick={() => setSelectedUser(null)} className="text-xl text-primary cursor-pointer mr-3 hover:text-secondary" />
            <img src={users.find(u => u.id === selectedUser)?.photo || 'https://via.placeholder.com/40'} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
            <span className="font-semibold">{users.find(u => u.id === selectedUser)?.virtualNumber}</span>
          </div>
          <div ref={chatRef} className="flex-1 overflow-y-auto bg-gray-50 p-2">
            {messages.map((msg) => (
              <motion.div
                key={msg._id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`message p-2 ${msg.senderId === userId ? 'text-right' : 'text-left'}`}
              >
                <div className={`inline-block p-2 rounded-lg ${msg.senderId === userId ? 'bg-primary text-white' : 'bg-white text-black'} shadow`}>
                  {msg.contentType === 'text' && <p>{msg.content}</p>}
                  {msg.caption && <p className="text-sm mt-1 italic">{msg.caption}</p>}
                  <span className="text-xs">{msg.status === 'sent' ? '✓' : msg.status === 'delivered' ? '✓✓' : '✅✅'}</span>
                </div>
              </motion.div>
            ))}
            {isTyping[selectedUser] && <p className="text-sm text-gray-500 p-2">Typing...</p>}
          </div>
          <motion.div initial={{ y: 20 }} animate={{ y: 0 }} className="bg-white p-2 flex items-center">
            <input
              value={message}
              onChange={(e) => { setMessage(e.target.value); handleTyping(); }}
              onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
              className="flex-1 p-2 border rounded-full focus:ring-2 focus:ring-primary"
              placeholder="Type a message"
            />
            <FaPaperPlane className="text-xl text-primary cursor-pointer hover:text-secondary ml-2" onClick={sendMessage} />
          </motion.div>
        </div>
      )}
    </motion.div>
  );
};

export default ChatScreen;