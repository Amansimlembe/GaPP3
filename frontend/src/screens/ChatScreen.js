import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import ChatBubble from '../components/ChatBubble';
import { motion } from 'framer-motion';

const socket = io('https://gapp-6yc3.onrender.com');

const ChatScreen = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [isVideoCall, setIsVideoCall] = useState(false);

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('user'));
    socket.emit('join', user.userId);
    socket.on('message', (msg) => setMessages((prev) => [...prev, msg]));
    socket.on('webrtc_signal', (data) => console.log('WebRTC signal:', data)); // Handle WebRTC signaling
    return () => {
      socket.off('message');
      socket.off('webrtc_signal');
    };
  }, []);

  const sendMessage = () => {
    const user = JSON.parse(localStorage.getItem('user'));
    socket.emit('message', { senderId: user.userId, recipientId, messageType: 'text', content: input });
    setInput('');
  };

  const startVideoCall = () => {
    setIsVideoCall(true);
    // Implement WebRTC logic here (e.g., getUserMedia, peer connection)
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col h-[80vh] bg-white rounded-lg shadow-lg p-4">
      <div className="flex-1 overflow-y-auto">
        {messages.map((msg, idx) => (
          <ChatBubble key={idx} message={msg} isSender={msg.senderId === JSON.parse(localStorage.getItem('user')).userId} />
        ))}
      </div>
      <div className="flex mt-4">
        <input placeholder="Recipient ID" value={recipientId} onChange={(e) => setRecipientId(e.target.value)} className="w-1/4 p-3 border rounded-l focus:outline-none focus:ring-2 focus:ring-primary" />
        <input value={input} onChange={(e) => setInput(e.target.value)} className="flex-1 p-3 border focus:outline-none focus:ring-2 focus:ring-primary" />
        <button onClick={sendMessage} className="bg-primary text-white p-3 rounded-r hover:bg-secondary transition duration-300">Send</button>
        <button onClick={startVideoCall} className="ml-2 bg-accent text-white p-3 rounded hover:bg-yellow-600 transition duration-300">Video Call</button>
      </div>
      {isVideoCall && <div className="mt-4">Video Call Placeholder (WebRTC Implementation Needed)</div>}
    </motion.div>
  );
};

export default ChatScreen;