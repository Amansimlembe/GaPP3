import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import ChatBubble from '../components/ChatBubble';

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
    <div>
      <div>
        {messages.map((msg, idx) => (
          <ChatBubble key={idx} message={msg} isSender={msg.senderId === JSON.parse(localStorage.getItem('user')).userId} />
        ))}
      </div>
      <input value={input} onChange={(e) => setInput(e.target.value)} />
      <button onClick={sendMessage}>Send</button>
    </div>
  );
};

export default ChatScreen;