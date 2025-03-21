import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import ChatBubble from '../components/ChatBubble';
import { motion } from 'framer-motion';

const socket = io('https://gapp-6yc3.onrender.com');

const ChatScreen = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('user'));
    socket.emit('join', user.userId);
    socket.on('message', (msg) => setMessages((prev) => [...prev, msg]));
    return () => socket.off('message');
  }, []);

  const sendMessage = () => {
    const user = JSON.parse(localStorage.getItem('user'));
    socket.emit('message', { senderId: user.userId, recipientId: 'someRecipientId', messageType: 'text', content: input });
    setInput('');
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col h-[80vh] bg-white rounded-lg shadow-lg p-4"
    >
      <div className="flex-1 overflow-y-auto">
        {messages.map((msg, idx) => (
          <ChatBubble key={idx} message={msg} isSender={msg.senderId === JSON.parse(localStorage.getItem('user')).userId} />
        ))}
      </div>
      <div className="flex mt-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="flex-1 p-3 border rounded-l focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          onClick={sendMessage}
          className="bg-primary text-white p-3 rounded-r hover:bg-secondary transition duration-300"
        >
          Send
        </button>
      </div>
    </motion.div>
  );
};

export default ChatScreen;