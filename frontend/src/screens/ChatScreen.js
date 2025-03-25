import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply, FaEllipsisH, FaSave } from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import { setMessages, addMessage, setSelectedChat } from '../store';
import { saveMessages, getMessages } from '../db';

const socket = io('https://gapp-6yc3.onrender.com');

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
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [viewMedia, setViewMedia] = useState(null);
  const [typing, setTyping] = useState(false);
  const [isTyping, setIsTyping] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [newContact, setNewContact] = useState('');
  const [error, setError] = useState('');
  const chatRef = useRef(null);
  const menuRef = useRef(null);

  const isSmallDevice = window.innerWidth < 768;

  useEffect(() => {
    if (!userId) return;
    socket.emit('join', userId);

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
      if (offlineMessages.length > 0 && !selectedChat) {
        offlineMessages.forEach((msg) => {
          dispatch(addMessage({ recipientId: msg.recipientId === userId ? msg.senderId : msg.recipientId, message: msg }));
        });
      }
    };
    loadOfflineMessages();

    const fetchMessages = async () => {
      if (!selectedChat) return;
      try {
        const { data } = await axios.get('/social/messages', {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId, recipientId: selectedChat, limit: 20 },
        });
        dispatch(setMessages({ recipientId: selectedChat, messages: data.map((msg) => ({ ...msg, status: msg.status || 'sent' })) }));
        chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
        setNotifications((prev) => ({ ...prev, [selectedChat]: 0 }));
      } catch (error) {
        dispatch(setMessages({ recipientId: selectedChat, messages: [] }));
        setError('No previous messages');
      }
    };
    fetchMessages();

    socket.on('message', (msg) => {
      saveMessages([msg]);
      const senderKnown = users.some((u) => u.id === msg.senderId);
      const updatedMsg = { ...msg, username: senderKnown ? msg.senderUsername : 'Unsaved Number' };
      dispatch(addMessage({ recipientId: msg.recipientId === userId ? msg.senderId : msg.recipientId, message: updatedMsg }));
      if (msg.recipientId === userId && !senderKnown) {
        setUsers((prev) => [
          ...prev,
          { id: msg.senderId, virtualNumber: msg.senderVirtualNumber, username: 'Unsaved Number', photo: msg.senderPhoto || 'https://placehold.co/40x40' },
        ]);
      }
      if ((msg.senderId === userId && msg.recipientId === selectedChat) || (msg.senderId === selectedChat && msg.recipientId === userId)) {
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
      dispatch(setMessages({
        recipientId: selectedChat,
        messages: (chats[selectedChat] || []).map((msg) => (msg._id === messageId ? { ...msg, status } : msg)),
      }));
    });

    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setShowMenu(false);
    };
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      socket.off('message');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [token, userId, selectedChat, dispatch]);

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
    const tempMsg = { _id: tempId, senderId: userId, recipientId: selectedChat, contentType, content: file ? URL.createObjectURL(file) : message, caption, status: 'sent', replyTo };
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
      setError('');
      socket.emit('messageStatus', { messageId: data._id, status: 'delivered', recipientId: selectedChat });
    } catch (error) {
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
    setTimeout(() => {
      socket.emit('stopTyping', { userId, recipientId: selectedChat });
      setTyping(false);
    }, 2000);
  };

  const deleteMessage = async (messageId) => {
    try {
      await axios.delete(`/social/message/${messageId}`, { headers: { Authorization: `Bearer ${token}` } });
      dispatch(setMessages({
        recipientId: selectedChat,
        messages: (chats[selectedChat] || []).filter((msg) => msg._id !== messageId),
      }));
      setSelectedMessage(null);
    } catch (error) {
      setError('Failed to delete message');
    }
  };

  const viewMessage = (msg) => {
    if (msg.senderId !== userId && msg.status === 'delivered') {
      socket.emit('messageStatus', { messageId: msg._id, status: 'read', recipientId: userId });
    }
    setViewMedia({ type: msg.contentType, url: msg.content });
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

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="flex h-screen bg-gray-100">
      <div className={`w-full md:w-1/3 bg-white border-r border-gray-200 flex flex-col ${isSmallDevice && selectedChat ? 'hidden' : 'block'}`}>
        <div className="p-4 flex justify-between items-center border-b border-gray-200">
          <h2 className="text-xl font-bold text-primary">Chats</h2>
          <FaEllipsisH onClick={() => setShowMenu(true)} className="text-2xl text-primary cursor-pointer hover:text-secondary" />
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
            <div className="bg-white p-3 flex items-center border-b border-gray-200">
              {isSmallDevice && (
                <FaArrowLeft onClick={() => dispatch(setSelectedChat(null))} className="text-xl text-primary cursor-pointer mr-3 hover:text-secondary" />
              )}
              <img src={users.find((u) => u.id === selectedChat)?.photo || 'https://placehold.co/40x40'} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
              <div>
                <span className="font-semibold">{users.find((u) => u.id === selectedChat)?.virtualNumber || 'Unknown'}</span>
                {isTyping[selectedChat] && <span className="text-sm text-green-500 ml-2">Typing...</span>}
              </div>
            </div>
            <div ref={chatRef} className="flex-1 overflow-y-auto bg-gray-100 p-2">
              {(chats[selectedChat] || []).length === 0 ? (
                <p className="text-center text-gray-500 mt-4">Start a new conversation</p>
              ) : (
                (chats[selectedChat] || []).map((msg) => (
                  <div key={msg._id} className={`flex ${msg.senderId === userId ? 'justify-end' : 'justify-start'} px-2 py-1`}>
                    <div
                      className={`max-w-[70%] p-2 rounded-lg shadow-sm ${msg.senderId === userId ? 'bg-green-500 text-white rounded-br-none' : 'bg-white text-black rounded-bl-none'} transition-all`}
                      onClick={() => setSelectedMessage(msg._id === selectedMessage ? null : msg._id)}
                      onDoubleClick={msg.contentType === 'video' ? () => viewMessage(msg) : null}
                    >
                      {msg.replyTo && (
                        <div className="bg-gray-100 p-1 rounded mb-1 text-xs italic text-gray-700">
                          <p>Replying to: {msg.replyTo?.content?.slice(0, 20) || 'Message'}...</p>
                        </div>
                      )}
                      {msg.contentType === 'text' && <p className="text-sm break-words">{msg.content}</p>}
                      {msg.contentType === 'image' && (
                        <div className="relative">
                          <img src={msg.content} alt="Chat" className="max-w-full h-auto rounded-lg cursor-pointer shadow-md" onClick={(e) => { e.stopPropagation(); viewMessage(msg); }} />
                          {msg.caption && <p className="text-xs mt-1 italic text-gray-300">{msg.caption}</p>}
                        </div>
                      )}
                      {msg.contentType === 'video' && (
                        <div className="relative">
                          <video src={msg.content} controls className="max-w-full h-auto rounded-lg cursor-pointer shadow-md" onClick={(e) => e.stopPropagation()} />
                          {msg.caption && <p className="text-xs mt-1 italic text-gray-300">{msg.caption}</p>}
                        </div>
                      )}
                      {msg.contentType === 'audio' && (
                        <div className="relative">
                          <audio src={msg.content} controls className="w-full" />
                          {msg.caption && <p className="text-xs mt-1 italic text-gray-300">{msg.caption}</p>}
                        </div>
                      )}
                      {msg.contentType === 'document' && (
                        <div className="flex items-center bg-gray-100 p-2 rounded-lg">
                          <a href={msg.content} target="_blank" rel="noopener noreferrer" className="text-blue-600 font-semibold truncate max-w-[200px] text-sm">{msg.content.split('/').pop()}</a>
                          {msg.caption && <p className="text-xs ml-2 italic text-gray-600">{msg.caption}</p>}
                        </div>
                      )}
                      {msg.senderId === userId && (
                        <span className="text-xs flex justify-end mt-1">
                          {msg.status === 'sent' && '✓'}
                          {msg.status === 'delivered' && '✓✓'}
                          {msg.status === 'read' && <span className="text-blue-300">✓✓</span>}
                        </span>
                      )}
                    </div>
                    {msg._id === selectedMessage && (
                      <div className="flex items-center ml-2">
                        <FaReply onClick={() => setReplyTo(msg)} className="text-primary cursor-pointer hover:text-secondary" />
                        {msg.senderId === userId && (
                          <FaTrash onClick={() => deleteMessage(msg._id)} className="text-red-500 cursor-pointer hover:text-red-700 ml-2" />
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="bg-white p-2 border-t border-gray-200 shadow-lg z-30 flex items-center">
              {replyTo && (
                <div className="bg-gray-100 p-2 mb-2 rounded w-full">
                  <p className="text-sm italic">Replying to: {replyTo.content.slice(0, 20)}...</p>
                  <button onClick={() => setReplyTo(null)} className="text-red-500 text-xs">Cancel</button>
                </div>
              )}
              <div className="flex items-center w-full max-w-3xl mx-auto">
                <FaPaperclip className="text-xl text-gray-500 cursor-pointer hover:text-gray-700 mr-2" onClick={() => setShowPicker(!showPicker)} />
                <input
                  value={message}
                  onChange={handleTyping}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  className="flex-1 p-2 border rounded-full focus:ring-2 focus:ring-green-500 bg-gray-100 text-sm"
                  placeholder="Type a message..."
                />
                <FaPaperPlane className="text-xl text-green-500 cursor-pointer hover:text-green-700 ml-2" onClick={sendMessage} />
              </div>
              {showPicker && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="absolute bottom-16 left-4 bg-white p-2 rounded-lg shadow-lg flex space-x-2 z-20"
                >
                  {['image', 'video', 'audio', 'document'].map((type) => (
                    <motion.button
                      key={type}
                      whileHover={{ scale: 1.1 }}
                      onClick={() => { setContentType(type); setShowPicker(false); }}
                      className="p-2 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
                    >
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </motion.button>
                  ))}
                </motion.div>
              )}
            </div>
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
          <FaArrowLeft onClick={(e) => { e.stopPropagation(); setViewMedia(null); }} className="absolute top-4 left-4 text-white text-2xl cursor-pointer hover:text-green-500" />
          {viewMedia.type === 'image' && <img src={viewMedia.url} alt="Full" className="max-w-full max-h-full object-contain rounded-lg shadow-lg" />}
          {viewMedia.type === 'video' && <video controls autoPlay src={viewMedia.url} className="max-w-full max-h-full object-contain rounded-lg shadow-lg" />}
          {viewMedia.type === 'audio' && <audio controls src={viewMedia.url} className="w-full" />}
          {viewMedia.type === 'document' && <iframe src={viewMedia.url} className="w-full h-full rounded-lg" title="Document" />}
        </motion.div>
      )}

      {error && <p className="text-red-500 text-center py-2 z-40 fixed top-0 w-full">{error}</p>}
    </motion.div>
  );
};

export default ChatScreen;