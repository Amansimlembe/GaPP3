import React from 'react';
import { motion } from 'framer-motion';

const ChatBubble = ({ message, isSender }) => (
  <motion.div
    initial={{ y: 20, opacity: 0 }}
    animate={{ y: 0, opacity: 1 }}
    className={`p-3 rounded-lg mb-2 ${isSender ? 'bg-primary text-white self-end' : 'bg-gray-200 text-gray-800 self-start'}`}
    style={{ maxWidth: '70%' }}
  >
    <p>{message.content}</p>
  </motion.div>
);

export default ChatBubble;