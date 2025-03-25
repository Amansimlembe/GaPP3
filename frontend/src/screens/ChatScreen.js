import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply, FaEllipsisH, FaSave, FaShare, FaCopy, FaForward } from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import { setMessages, addMessage, setSelectedChat } from '../store';
import { saveMessages, getMessages } from '../db';
import * as signal from 'libsignal-protocol';

const socket = io('https://gapp-6yc3.onrender.com');


  // Helper to generate or retrieve key pair
  const getKeyPair = async () => {
    const storedKeys = localStorage.getItem('signalKeys');
    if (storedKeys) return JSON.parse(storedKeys);
  
    const keyPair = await signal.KeyHelper.generateIdentityKeyPair();
    const registrationId = signal.KeyHelper.generateRegistrationId();
    const preKey = await signal.KeyHelper.generatePreKey(1);
    const signedPreKey = await signal.KeyHelper.generateSignedPreKey(keyPair, 1);
  
    const keys = {
      identityKeyPair: keyPair,
      registrationId,
      preKeys: [preKey],
      signedPreKey,
    };
    localStorage.setItem('signalKeys', JSON.stringify(keys));
    return keys;
  };
  
  // Encrypt message
  const encryptMessage = async (message, recipientId) => {
    const keys = await getKeyPair();
    const address = new signal.SignalProtocolAddress(recipientId, 1);
    const sessionBuilder = new signal.SessionBuilder({
      storage: {
        get: (key) => localStorage.getItem(key),
        put: (key, value) => localStorage.setItem(key, value),
        remove: (key) => localStorage.removeItem(key),
      },
    }, address);
    await sessionBuilder.processPreKey({
      registrationId: keys.registrationId,
      identityKey: keys.identityKeyPair.pubKey,
      signedPreKey: keys.signedPreKey,
      preKey: keys.preKeys[0],
    });
    const sessionCipher = new signal.SessionCipher({
      storage: {
        get: (key) => localStorage.getItem(key),
        put: (key, value) => localStorage.setItem(key, value),
        remove: (key) => localStorage.removeItem(key),
      },
    }, address);
    const messageBuffer = signal.util.toArrayBuffer(new TextEncoder().encode(message));
    const encrypted = await sessionCipher.encrypt(messageBuffer);
    return encrypted;
  };
  
  // Decrypt message
  const decryptMessage = async (encryptedMessage, senderId) => {
    const keys = await getKeyPair();
    const address = new signal.SignalProtocolAddress(senderId, 1);
    const sessionCipher = new signal.SessionCipher({
      storage: {
        get: (key) => localStorage.getItem(key),
        put: (key, value) => localStorage.setItem(key, value),
        remove: (key) => localStorage.removeItem(key),
      },
    }, address);
    const decryptedBuffer = await sessionCipher.decryptPreKeyWhisperMessage(encryptedMessage.body, 'binary');
    const decrypted = new TextDecoder().decode(new Uint8Array(decryptedBuffer));
    return decrypted;
  };       


  
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
          params: { userId, recipientId: selectedChat, limit: 50 },
        });
        const decryptedMessages = await Promise.all(
          data.map(async (msg) => {
            if (msg.contentType === 'text' && msg.content) {
              try {
                const decryptedContent = await decryptMessage(msg.content, msg.senderId);
                return { ...msg, content: decryptedContent, status: msg.status || 'sent' };
              } catch (err) {
                console.error('Decryption error:', err);
                return { ...msg, content: '[Encrypted]', status: msg.status || 'sent' };
              }
            }
            return { ...msg, status: msg.status || 'sent' };
          })
        );
        dispatch(setMessages({ recipientId: selectedChat, messages: decryptedMessages }));
        setNotifications((prev) => ({ ...prev, [selectedChat]: 0 }));

        // Calculate unread messages
        const lastReadIndex = decryptedMessages.findIndex((msg) => msg.recipientId === userId && msg.status === 'read');
        const unreadMessages = decryptedMessages.slice(lastReadIndex + 1).filter((msg) => msg.recipientId === userId);
        setUnreadCount(unreadMessages.length);
        if (unreadMessages.length > 0) {
          setFirstUnreadMessageId(unreadMessages[0]._id);
        }

        // Scroll to last message if no new messages, otherwise to first unread
        if (unreadMessages.length === 0) {
          chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
        } else {
          const firstUnreadElement = document.getElementById(`message-${unreadMessages[0]._id}`);
          if (firstUnreadElement) {
            firstUnreadElement.scrollIntoView({ behavior: 'smooth' });
          }
        }
      } catch (error) {
        dispatch(setMessages({ recipientId: selectedChat, messages: [] }));
        setError('No previous messages');
      }
    };
    fetchMessages();

    socket.on('message', async (msg) => {
      saveMessages([msg]);
      const senderKnown = users.some((u) => u.id === msg.senderId);
      let updatedMsg = { ...msg, username: senderKnown ? msg.senderUsername : 'Unsaved Number' };
      if (msg.contentType === 'text' && msg.content) {
        try {
          const decryptedContent = await decryptMessage(msg.content, msg.senderId);
          updatedMsg = { ...updatedMsg, content: decryptedContent };
        } catch (err) {
          console.error('Decryption error:', err);
          updatedMsg = { ...updatedMsg, content: '[Encrypted]' };
        }
      }
      dispatch(addMessage({ recipientId: msg.recipientId === userId ? msg.senderId : msg.recipientId, message: updatedMsg }));
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

    let encryptedContent = message;
    if (contentType === 'text' && message) {
      encryptedContent = await encryptMessage(message, selectedChat);
    }

    const formData = new FormData();
    formData.append('senderId', userId);
    formData.append('recipientId', selectedChat);
    formData.append('contentType', contentType);
    formData.append('caption', caption);
    if (file) formData.append('content', file);
    else formData.append('content', encryptedContent);
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

  const deleteMessages = async () => {
    if (selectedMessages.length === 0) return;
    try {
      await Promise.all(
        selectedMessages.map((messageId) =>
          axios.delete(`/social/message/${messageId}`, { headers: { Authorization: `Bearer ${token}` } })
        )
      );
      dispatch(setMessages({
        recipientId: selectedChat,
        messages: (chats[selectedChat] || []).filter((msg) => !selectedMessages.includes(msg._id)),
      }));
      setSelectedMessages([]);
      setShowDeleteConfirm(false);
    } catch (error) {
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
      setShowPicker(false);
    }
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
            <div className="bg-white p-3 flex items-center border-b border-gray-200">
              {isSmallDevice && (
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaArrowLeft
                    onClick={() => {
                      dispatch(setSelectedChat(null));
                      document.querySelector('.bottom-nav').style.display = 'flex';
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
            <div ref={chatRef} className="flex-1 overflow-y-auto bg-gray-100 p-2 pb-16">
              {(chats[selectedChat] || []).length === 0 ? (
                <p className="text-center text-gray-500 mt-4">Start a new conversation</p>
              ) : (
                <>
                  {(chats[selectedChat] || []).map((msg, index) => (
                    <React.Fragment key={msg._id}>
                      {firstUnreadMessageId === msg._id && unreadCount > 0 && (
                        <div className="text-center my-2">
                          <span className="bg-blue-500 text-white px-2 py-1 rounded-full text-sm">
                            {unreadCount} Unread Messages
                          </span>
                        </div>
                      )}
                      <div
                        id={`message-${msg._id}`}
                        className={`flex ${msg.senderId === userId ? 'justify-end' : 'justify-start'} px-2 py-1`}
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
                            <div className="bg-gray-100 p-1 rounded mb-1 text-xs italic text-gray-700">
                              <p>Replying to: {msg.replyTo?.content?.slice(0, 20) || 'Message'}...</p>
                            </div>
                          )}
                          {msg.contentType === 'text' && <p className="text-sm break-words">{msg.content}</p>}
                          {msg.contentType === 'image' && (
                            <div className="relative">
                              <img
                                src={msg.content}
                                alt="Chat"
                                className="max-w-full h-40 object-contain rounded-lg cursor-pointer shadow-md"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  viewMessage(msg);
                                }}
                              />
                              {msg.caption && <p className="text-xs mt-1 italic text-gray-300">{msg.caption}</p>}
                            </div>
                          )}
                          {msg.contentType === 'video' && (
                            <div className="relative">
                              <video
                                src={msg.content}
                                className="max-w-full h-40 object-contain rounded-lg cursor-pointer shadow-md"
                                onClick={(e) => e.stopPropagation()}
                              />
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
                              <a
                                href={msg.content}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 font-semibold truncate max-w-[200px] text-sm"
                              >
                                {msg.content.split('/').pop()}
                              </a>
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
                        <div className="flex items-center ml-2">
                          <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                            <FaReply
                              onClick={() => setReplyTo(msg)}
                              className="text-primary cursor-pointer hover:text-secondary"
                            />
                          </motion.div>
                          <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                            <FaForward
                              onClick={() => forwardMessage(msg)}
                              className="text-primary cursor-pointer hover:text-secondary ml-2"
                            />
                          </motion.div>
                          <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                            <FaCopy
                              onClick={() => copyMessage(msg)}
                              className="text-primary cursor-pointer hover:text-secondary ml-2"
                            />
                          </motion.div>
                          <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                            <FaShare
                              onClick={() => shareMessage(msg)}
                              className="text-primary cursor-pointer hover:text-secondary ml-2"
                            />
                          </motion.div>
                          {msg.senderId === userId && (
                            <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                              <FaTrash
                                onClick={() => {
                                  setSelectedMessages([msg._id]);
                                  setShowDeleteConfirm(true);
                                }}
                                className="text-red-500 cursor-pointer hover:text-red-700 ml-2"
                              />
                            </motion.div>
                          )}
                        </div>
                      </div>
                    </React.Fragment>
                  ))}
                </>
              )}
            </div>
            <div className="bg-white p-2 border-t border-gray-200 shadow-lg z-30 flex items-center">
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
              <div className={`flex items-center ${isSmallDevice ? 'w-[90%]' : 'w-full max-w-3xl'} mx-auto`}>
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