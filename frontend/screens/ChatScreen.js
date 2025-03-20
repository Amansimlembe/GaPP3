import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import ChatBubble from '../components/ChatBubble';

// Use the Render URL for production
const socket = io('https://gapp-6yc3.onrender.com');

const ChatScreen = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    // Define an async function inside useEffect
    const initializeSocket = async () => {
      const user = JSON.parse(localStorage.getItem('user'));
      if (user) {
        socket.emit('join', user.userId);
        socket.on('message', (msg) => setMessages((prev) => [...prev, msg]));
      }
    };

    initializeSocket();

    // Cleanup socket listener on unmount
    return () => {
      socket.off('message');
    };
  }, []); // Empty dependency array since we only run this once on mount

  const sendMessage = () => {
    const user = JSON.parse(localStorage.getItem('user'));
    if (user && input.trim()) {
      socket.emit('message', {
        senderId: user.userId,
        recipientId: 'someRecipientId', // Replace with dynamic recipient ID in production
        messageType: 'text',
        content: input,
      });
      setInput('');
    }
  };

  return (
    <div>
      <div style={{ height: '80vh', overflowY: 'scroll' }}>
        {messages.map((msg, idx) => (
          <ChatBubble
            key={idx}
            message={msg}
            isSender={msg.senderId === JSON.parse(localStorage.getItem('user'))?.userId}
          />
        ))}
      </div>
      <div style={{ display: 'flex', padding: 10 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{ flex: 1, marginRight: 10 }}
        />
        <button onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
};

export default ChatScreen;