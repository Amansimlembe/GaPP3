import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import ChatBubble from '../components/ChatBubble';
import { motion } from 'framer-motion';
import Peer from 'simple-peer';

const socket = io('https://gapp-6yc3.onrender.com');

const ChatScreen = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [peer, setPeer] = useState(null);
  const videoRef = useRef();
  const remoteVideoRef = useRef();

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('user'));
    socket.emit('join', user.userId);
    socket.on('message', (msg) => setMessages((prev) => [...prev, msg]));
    socket.on('webrtc_signal', (data) => {
      if (peer) peer.signal(data.signal);
    });
    return () => {
      socket.off('message');
      socket.off('webrtc_signal');
    };
  }, [peer]);

  const sendMessage = () => {
    const user = JSON.parse(localStorage.getItem('user'));
    const message = { senderId: user.userId, recipientId, messageType: 'text', content: input };
    socket.emit('message', message);
    setInput('');
  };

  const startVideoCall = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    videoRef.current.srcObject = stream;
    const newPeer = new Peer({ initiator: true, stream });
    newPeer.on('signal', (signal) => {
      socket.emit('webrtc_signal', { to: recipientId, signal });
    });
    newPeer.on('stream', (remoteStream) => {
      remoteVideoRef.current.srcObject = remoteStream;
    });
    setPeer(newPeer);
    setIsVideoCall(true);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col h-[80vh] bg-white rounded-lg shadow-lg p-4">
      <div className="flex mb-4">
        <input
          placeholder="Recipient ID"
          value={recipientId}
          onChange={(e) => setRecipientId(e.target.value)}
          className="flex-1 p-2 border rounded-l focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button onClick={startVideoCall} className="bg-accent text-white p-2 rounded-r hover:bg-yellow-600 transition duration-300">Video Call</button>
      </div>
      {isVideoCall && (
        <div className="flex mb-4">
          <video ref={videoRef} autoPlay className="w-1/2 rounded" />
          <video ref={remoteVideoRef} autoPlay className="w-1/2 rounded" />
        </div>
      )}
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
        <button onClick={sendMessage} className="bg-primary text-white p-3 rounded-r hover:bg-secondary transition duration-300">Send</button>
      </div>
    </motion.div>
  );
};

export default ChatScreen;