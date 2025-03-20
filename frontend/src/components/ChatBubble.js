import React from 'react';

const ChatBubble = ({ message, isSender }) => (
  <div style={{ padding: 10, alignSelf: isSender ? 'flex-end' : 'flex-start', backgroundColor: isSender ? '#DCF8C6' : '#FFF', margin: 5, borderRadius: 5 }}>
    <p>{message.content}</p>
  </div>
);

export default ChatBubble;