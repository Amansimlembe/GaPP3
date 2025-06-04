import React, { useState, useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import forge from 'node-forge';
import { List, AutoSizer } from 'react-virtualized';
import { format, isToday, isYesterday, parseISO} from 'date-fns';
import {
  FaPaperPlane, FaPaperclip, FaTrash, FaArrowLeft, FaReply, FaEllipsisH, FaFileAlt,
  FaPlay, FaArrowDown, FaUserPlus, FaSignOutAlt, FaUser, FaCamera, FaVideo, FaMicrophone, FaEdit, FaSmile, FaTimes
} from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import EmojiPicker from 'emoji-picker-react';
import { debounce } from 'lodash';
import { useSwipeable } from 'react-swipeable';
import { setMessages, addMessage, updateMessageStatus, setSelectedChat, resetState, replaceMessage, deleteMessage } from '../store';
import { saveMessages, getMessages, clearOldMessages, savePendingMessages, loadPendingMessages, clearPendingMessages, clearDatabase } from '../db';
import './ChatScreen.css';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

// Generate unique client message ID
const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const ChatScreen = React.memo(({ token, userId, setAuth, socket, username, virtualNumber, photo }) => {
  const dispatch = useDispatch();
  const { chats, selectedChat } = useSelector((state) => state.messages);
  const [users, setUsers] = useState(() => JSON.parse(localStorage.getItem('cachedUsers')) || []);
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState([]);
  const [captions, setCaptions] = useState({});
  const [contentType, setContentType] = useState('text');
  const [isTyping, setIsTyping] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [menuTab, setMenuTab] = useState('');
  const [newContactNumber, setNewContactNumber] = useState('');
  const [error, setError] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [mediaPreview, setMediaPreview] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [pendingMessages, setPendingMessages] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({});
  const [editingMessage, setEditingMessage] = useState(null);
  const [isAddingContact, setIsAddingContact] = useState(false);
  const chatRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isAtBottomRef = useRef(true);

  // Validate ObjectId
  const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

  const handleLogout = useCallback(() => {
    try {
      socket.emit('leave', userId);
      dispatch(resetState());
      localStorage.clear();
      setUsers([]);
      setAuth('', '', '', '', '');
      console.log('Logged out successfully');
    } catch (err) {
      console.error('Logout error:', err);
      setError('Failed to logout');
    }
  }, [dispatch, setAuth, userId, socket]);

  const encryptMessage = useCallback(async (content, recipientPublicKey, isMedia = false) => {
    try {
      const aesKey = forge.random.getBytesSync(32);
      const iv = forge.random.getBytesSync(16);
      const cipher = forge.cipher.createCipher('AES-CBC', aesKey);
      cipher.start({ iv });
      cipher.update(forge.util.createBuffer(isMedia ? content : forge.util.encodeUtf8(content)));
      cipher.finish();
      const encrypted = `${forge.util.encode64(cipher.output.getBytes())}|${forge.util.encode64(iv)}|${forge.util.encode64(
        forge.pki.publicKeyFromPem(recipientPublicKey).encrypt(aesKey, 'RSA-OAEP', { md: forge.md.sha256.create() })
      )}`;
      console.log('Message encrypted successfully');
      return encrypted;
    } catch (err) {
      console.error('Encryption error:', err);
      throw new Error('Failed to encrypt message');
    }
  }, []);

  const decryptMessage = useCallback(async (encryptedContent, privateKeyPem, isMedia = false) => {
    try {
      if (!encryptedContent || typeof encryptedContent !== 'string' || !encryptedContent.includes('|')) {
        throw new Error('Invalid encrypted content format');
      }
      const [encryptedData, iv, encryptedAesKey] = encryptedContent.split('|').map(forge.util.decode64);
      const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
      const aesKey = privateKey.decrypt(encryptedAesKey, 'RSA-OAEP', { md: forge.md.sha256.create() });
      const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
      decipher.start({ iv });
      decipher.update(forge.util.createBuffer(encryptedData));
      decipher.finish();
      const decrypted = isMedia ? decipher.output.getBytes() : forge.util.decodeUtf8(decipher.output.getBytes());
      console.log('Message decrypted successfully');
      return decrypted;
    } catch (err) {
      console.error('Decryption error:', err);
      return isMedia ? null : '[Decryption failed]';
    }
  }, []);

  const getPublicKey = useCallback(async (recipientId) => {
    if (!isValidObjectId(recipientId)) {
      throw new Error('Invalid recipientId');
    }
    const cacheKey = `publicKey:${recipientId}`;
    const cachedKey = localStorage.getItem(cacheKey);
    if (cachedKey) return cachedKey;
    try {
      const { data } = await axios.get(`${BASE_URL}/auth/public_key/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      localStorage.setItem(cacheKey, data.publicKey);
      console.log(`Public key fetched for ${recipientId}`);
      return data.publicKey;
    } catch (err) {
      console.error(`Failed to fetch public key for ${recipientId}:`, err);
      throw err;
    }
  }, [token]);

  const compressImage = async (file) => {
    try {
      return new Promise((resolve) => {
        const img = new Image();
        const reader = new FileReader();
        reader.onload = (e) => {
          img.src = e.target.result;
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const maxWidth = 800;
            const maxHeight = 800;
            let width = img.width;
            let height = img.height;

            if (width > height) {
              if (width > maxWidth) {
                height *= maxWidth / width;
                width = maxWidth;
              }
            } else {
              if (height > maxHeight) {
                width *= maxHeight / height;
                height = maxHeight;
              }
            }

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            canvas.toBlob(
              (blob) => resolve(new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() })),
              'image/jpeg',
              0.7
            );
          };
        };
        reader.readAsDataURL(file);
      });
    } catch (err) {
      console.error('Image compression error:', err);
      throw err;
    }
  };

  const formatChatListDate = (date) => format(parseISO(date), 'hh:mm a');
  const formatDateHeader = (date) => {
    const parsed = parseISO(date);
    if (isToday(parsed)) return 'Today';
    if (isYesterday(parsed)) return 'Yesterday';
    return format(parsed, 'MMM d, yyyy');
  };
  const formatTime = (date) => format(parseISO(date), 'hh:mm a');

  const initializeChat = useCallback((recipientId) => {
    if (!recipientId || !isValidObjectId(recipientId) || chats[recipientId]) return;
    dispatch(setMessages({ recipientId, messages: [] }));
    console.log(`Initialized chat for recipientId: ${recipientId}`);
  }, [dispatch, chats]);

  const fetchChatList = useCallback(
    debounce(async (retryCount = 3) => {
      const cached = localStorage.getItem('cachedUsers');
      if (cached) {
        try {
          const parsedUsers = JSON.parse(cached);
          setUsers(parsedUsers);
          console.log('Chat list loaded from cache');
          return;
        } catch (err) {
          console.error('Failed to parse cached users:', err);
        }
      }
      let attempt = 0;
      while (attempt < retryCount) {
        try {
          const { data } = await axios.get(`${BASE_URL}/social/chat-list`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { userId },
            timeout: 10000,
          });
          const privateKeyPem = localStorage.getItem('privateKey');
          const processedUsers = await Promise.all(
            data.map(async (user) => {
              if (user.latestMessage) {
                user.latestMessage.content =
                  user.latestMessage.senderId === userId
                    ? `You: ${user.latestMessage.plaintextContent || '[Media]'}` 
                    : user.latestMessage.recipientId === userId && user.latestMessage.contentType === 'text'
                    ? await decryptMessage(user.latestMessage.content, privateKeyPem)
                    : `[${user.latestMessage.contentType}]`;
              }
              return user;
            })
          );
          setUsers(processedUsers);
          localStorage.setItem('cachedUsers', JSON.stringify(processedUsers));
          setError('');
          socket.emit('chatListUpdated', { userId, users: processedUsers });
          console.log('Chat list fetched successfully');
          return;
        } catch (err) {
          attempt++;
          console.error(`Fetch chat list attempt ${attempt} failed:`, err);
          if (err.response?.status === 401) {
            setError('Session expired, please log in again');
            setTimeout(() => handleLogout(), 2000);
            return;
          }
          if (err.response?.status === 429) {
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          }
          if (attempt === retryCount) {
            setError('Failed to load chat list');
          }
        }
      }
    }, 500),
    [token, userId, handleLogout, decryptMessage, socket]
  );

  const fetchMessages = useCallback(
    debounce(async (recipientId, retryCount = 3) => {
      if (!recipientId || !isValidObjectId(recipientId)) {
        console.warn('Invalid recipientId:', recipientId);
        dispatch(setMessages({ recipientId, messages: [] }));
        setError('Invalid chat selected');
        return;
      }
      try {
        const localMessages = await getMessages(recipientId);
        if (localMessages.length) {
          dispatch(setMessages({ recipientId, messages: localMessages }));
          listRef.current?.scrollToRow(localMessages.length - 1);
          console.log(`Loaded ${localMessages.length} messages from IndexedDB for ${recipientId}`);
          return;
        }
      } catch (err) {
        console.error('Failed to load local messages:', err);
      }
      let attempt = 0;
      while (attempt < retryCount) {
        try {
          const { data } = await axios.get(`${BASE_URL}/social/messages`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { userId, recipientId, limit: 50, skip: 0 },
            timeout: 10000,
          });
          const privateKeyPem = localStorage.getItem('privateKey');
          const messages = await Promise.all(
            data.messages.map(async (msg) => {
              const newMsg = { ...msg };
              if (msg.senderId === userId) {
                newMsg.content = msg.plaintextContent || msg.content;
              } else if (msg.recipientId === userId) {
                newMsg.content =
                  msg.contentType === 'text' ? await decryptMessage(msg.content, privateKeyPem) : msg.content;
              }
              return newMsg;
            })
          );
          dispatch(setMessages({ recipientId, messages }));
          await saveMessages(messages);
          listRef.current?.scrollToRow(messages.length - 1);
          console.log(`Fetched ${messages.length} messages for ${recipientId}`);
          setError('');
          return;
        } catch (err) {
          attempt++;
          console.error(`Fetch messages attempt ${attempt} failed:`, err);
          if (err.response?.status === 401) {
            setError('Session expired, please log in again');
            setTimeout(() => handleLogout(), 2000);
            return;
          }
          if (err.response?.status === 429) {
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          }
          if (attempt === retryCount) {
            setError('Failed to load messages');
            dispatch(setMessages({ recipientId, messages: [] }));
          }
        }
      }
    }, 500),
    [token, userId, dispatch, decryptMessage, handleLogout]
  );

  const sendPendingMessages = useCallback(async () => {
    if (!navigator.onLine || !pendingMessages.length) return;
    const successfulSends = [];
    for (const { tempId, recipientId, messageData } of pendingMessages) {
      if (!isValidObjectId(recipientId)) {
        console.warn('Invalid recipientId in pending message:', recipientId);
        continue;
      }
      try {
        await new Promise((resolve, reject) => {
          socket.emit('message', messageData, (ack) => {
            if (ack.error) {
              console.error('Pending message send error:', ack.error);
              return reject(new Error(ack.error));
            }
            const { message: sentMessage } = ack;
            dispatch(
              replaceMessage({
                recipientId,
                message: { ...sentMessage, content: sentMessage.plaintextContent || sentMessage.content },
                replaceId: tempId,
              })
            );
            saveMessages([{ ...sentMessage, content: sentMessage.plaintextContent || sentMessage.content }])
              .then(() => successfulSends.push(tempId))
              .catch((err) => console.error('Failed to save pending message:', err));
            resolve();
          });
        });
      } catch (err) {
        console.error('Pending message send error:', err);
      }
    }
    if (successfulSends.length) {
      const updatedPending = pendingMessages.filter((p) => !successfulSends.includes(p.tempId));
      setPendingMessages(updatedPending);
      await savePendingMessages(updatedPending);
      if (!updatedPending.length) {
        await clearPendingMessages();
      }
      console.log(`Sent ${successfulSends.length} pending messages`);
    }
  }, [pendingMessages, socket, dispatch]);

  const handleFileChange = useCallback(
    async (e, type) => {
      try {
        const selectedFiles = Array.from(e.target.files);
        if (!selectedFiles.length || !selectedChatRef.current) {
          setError('No files selected');
          return;
        }
const compressedFiles = await Promise.all(
  selectedFiles.map((file) => (file.type.startsWith('image') ? compressImage(file) : file))
);
setFiles(compressedFiles);
setContentType(type);
setMediaPreview(
  compressedFiles.map((file) => ({
    type,
    content: URL.createObjectURL(file),
    originalFile: file,
    caption: captions[file.name] || '',
  }))
);
const tempMessages = compressedFiles.map((file) => {
  const clientMessageId = generateClientMessageId();
  return {
    _id: clientMessageId,
    senderId: userId,
    recipientId: selectedChat,
    content: URL.createObjectURL(file),
    contentType: type,
    status: 'uploading',
    createdAt: new Date().toISOString(),
    originalFilename: file.name,
    uploadProgress: 0,
    clientMessageId,
    senderVirtualNumber: virtualNumber,
    senderUsername: username,
    senderPhoto: photo,
  };
});

        tempMessages.forEach((msg) => {
  dispatch(addMessage({ recipientId: selectedChat, message: msg }));
  console.log('Added temporary media message:', msg._id);
});

 if (listRef.current && isAtBottomRef.current && chats[selectedChat]?.length) {
  listRef.current.scrollToRow(chats[selectedChat].length - 1);
}



        for (let [index, file] of compressedFiles.entries()) {
          const clientMessageId = tempMessages[index]._id;
          const retryUpload = async (retryCount = 3) => {
            let attempt = 0;
            while (attempt < retryCount) {
              const formData = new FormData();
              try {
                formData.append(fileFormData, file);
                formData.append('userId', userId);
                formData.append('recipientId', selectedChatRef.current);
                formData.append('clientMessageId', clientMessageId);
                formData.append('senderVirtualNumber', virtualNumber);
                formData.append('senderUsername', username);
                formData.append('senderPhoto', photo);
                if (captions[clientMessageId]) {
                  formData.append('caption', captions[clientMessageId]);
                }

                const response = await axios.post(`${BASE_URL}/social/upload`, formData, {
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'multipart/form-data',
                  },
                 onUploadProgress: (data) => {
  const percentCompleted = Math.round((data.loaded * 100) / data.total);
  setUploadProgress((prev) => ({ ...prev, [clientMessageId]: percentCompleted }));
  dispatch(
    updateMessageStatus({
      recipientId: selectedChat,
      messageId: clientMessageId,
      status: 'uploading',
      uploadProgress: percentCompleted,
    })
  );
  console.log(`Upload progress for ${clientMessageId}: ${percentCompleted}%`);
}

                
                });

                const { message: uploadedMessage } = response.data;
                dispatch(
                  updateMessage({
                    recipientId: selectedChatRef.current,
                    message: uploadedMessage,
                    replaceId: clientMessageId
                  })
                );
                socket.emit('messageStatus', uploadedMessage);
                await saveMessages([uploadedMessage]);
                console.log('Media uploaded successfully:', uploadedMessage._id);
                return;
              } catch (error) {
                console.error(`Media upload attempt ${attempt + 1} failed:`, error);
                attempt++;
                if (error.response?.status === 401) {
                  setError('Session expired, please log in again');
                  setTimeout(() => handleLogout(), 1000);
                  return;
                }
                if (error.response?.status === 429) {
                  await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
                }
                if (attempt === retryCount) {
                  dispatch(
                    updateMessageStatus({
                      recipientId: selectedChatRef.current,
                      messageId: clientMessageId,
                      status: 'failed',
                      uploadProgress: false,
                    })
                  );
                  setError('Failed to upload media');
                  console.log(`Media upload failed for ${clientMessageId}`);
                }
              }
            }
          };

          retryUpload();
        }

        setFiles([]);
        setMediaPreview([]);
        setCaptions({});
        setMessage('');
        setReplyTo(null);
        inputRef.current?.focus();
        console.log('File change processed successfully');
      } catch (err) {
        console.error('File change error:', err);
        setError('Error processing file');
      }
    },
    [selectedChat, userId, token, socket, dispatch, virtualNumber, username, photo, captions, chats]
  );

  const handleAddContact = useCallback(async () => {
    if (!newContactNumber.trim()) {
      setError('Please enter a virtual number');
      console.warn('Empty virtual number');
      return;
    }

    setIsAddingContact(true);
    try {
      let attempt = 0;
      const maxRetries = 3;
      while (attempt < maxRetries) {
        try {
          const { data } = await axios.post(
            `${BASE_URL}/social/add_contact`,
            { userId, virtualNumber: newContactNumber.trim() },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
          );
          if (!data?.id || !isValidObjectId(data.id)) {
            throw new Error('Invalid contact data');
          }

          setUsers((prevUsers) => {
            const exists = prevUsers.some((u) => u.id === data.id);
            if (exists) {
              setError('Contact already exists');
              return prevUsers;
            }
            const updatedUsers = [...prevUsers, data];
            localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
            initializeChat(data.id);
            console.log('Added contact:', data.id);
            return updatedUsers;
          });

          socket.emit('newContact', { userId, contactData: data });
          setNewContactNumber('');
          setMenuTab('');
          setShowMenu(false);
          setError('');
          return;
        } catch (err) {
          attempt++;
          console.error(`Add contact attempt ${attempt} failed:`, err);
          if (err.response?.status === 400) {
            setError('Contact does not exist or already added');
            return;
          }
          if (err.response?.status === 401) {
            setError('Session expired, please log in again');
            setTimeout(() => handleLogout(), 1000);
            return;
          }
          if (err.response?.status === 429) {
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          }
          if (attempt === maxRetries) {
            throw err;
          }
        }
      }
    } catch (err) {
      setError('Failed to add contact');
      console.error('Add contact error:', err);
    } finally {
      setIsAddingContact(false);
    }
  }, [newContactNumber, userId, token, socket, handleLogout, initializeChat]);

  const sendMessage = useCallback(async () => {
    if (!message.trim() || !selectedChat || !isValidObjectId(selectedChat)) {
      setError('Cannot send empty message or invalid chat');
      console.warn('Invalid message or chat:', { message, selectedChat });
      return;
    }

    const recipientId = selectedChat;
    const clientMessageId = generateClientMessageId();
    const plaintextContent = message.trim();

    try {
      const recipientPublicKey = await getPublicKey(recipientId);
      const encryptedContent = await encryptMessage(plaintextContent, recipientPublicKey);

      const tempMessage = {
        _id: clientMessageId,
        senderId: userId,
        recipientId,
        content: plaintextContent,
        contentType: 'text',
        plaintextContent,
        status: 'pending',
        createdAt: new Date().toISOString(),
        clientMessageId,
        senderVirtualNumber,
        senderUsername,
        senderPhoto,
        replyTo: replyTo ? { ...replyTo, content: replyTo.content } : undefined,
      };

      dispatch(addMessage({ recipientId, message: tempMessage }));
      await saveMessages([tempMessage]);
      console.log('Added temporary message:', clientMessageId);

      if (listRef.current && chats[recipientId]?.length) {
        listRef.current.scrollToRow(chats[recipientId].length);
        console.log(`Scrolled to row ${chats[recipientId].length} for ${recipientId}`);
      }

      const messageData = {
        senderId: userId,
        recipientId,
        content: encryptedContent,
        contentType: 'text',
        plaintextContent,
        clientMessageId,
        senderVirtualNumber,
        senderUsername,
        senderPhoto,
        replyTo: replyTo ? replyTo._id : undefined,
      };

      socket.emit('message', messageData, async (ack) => {
        if (ack?.error) {
          console.error('Socket acknowledgment error:', ack.error);
          setError(`Failed to send message: ${ack.error}`);
          dispatch(updateMessageStatus({
            recipientId,
            messageId: clientMessageId,
            status: 'failed',
          }));
          setPendingMessages((prev) => [
            ...prev,
            { tempId: clientMessageId, recipientId, messageData },
          ]);
          await savePendingMessages([
            ...pendingMessages,
            { tempId: clientMessageId, recipientId, messageData },
          ]);
          return;
        }
        if (!ack?.message?._id) {
          console.error('Invalid acknowledgment:', ack);
          setError('Invalid server response');
          dispatch(updateMessageStatus({
            recipientId,
            messageId: clientMessageId,
            status: 'failed',
          }));
          return;
        }
        const { message: sentMessage } = ack;
        dispatch(
          replaceMessage({
            recipientId,
            message: { ...sentMessage, content: plaintextContent },
            replaceId: clientMessageId,
          })
        );
        await saveMessages([{ ...sentMessage, content: plaintextContent }]);
        if (listRef.current && chats[recipientId]?.length) {
          listRef.current.scrollToRow(chats[recipientId].length);
          console.log(`Scrolled to row ${chats[recipientId].length} after replacing message`);
        }
        console.log('Message sent and replaced:', sentMessage._id);
      });

      setMessage('');
      setReplyTo(null);
      setShowEmojiPicker(false);
      socket.emit('stopTyping', { userId, recipientId });
      inputRef.current?.focus();
    } catch (err) {
      console.error('Send message error:', err);
      setError(`Failed to send message: ${err.message}`);
      dispatch(updateMessageStatus({
        recipientId,
        messageId: clientMessageId,
        status: 'failed',
      }));
      setPendingMessages((prev) => [
        ...prev,
        {
          tempId: clientMessageId,
          recipientId,
          messageData: {
            senderId: userId,
            recipientId,
            content: plaintextContent,
            contentType: 'text',
            plaintextContent,
            clientMessageId,
            senderVirtualNumber,
            senderUsername,
            senderPhoto,
            replyTo: replyTo ? replyTo._id : undefined,
          },
        },
      ]);
      await savePendingMessages([
        ...pendingMessages,
        {
          tempId: clientMessageId,
          recipientId,
          messageData: {
            senderId: userId,
            recipientId,
            content: plaintextContent,
            contentType: 'text',
            plaintextContent,
            clientMessageId,
            senderVirtualNumber,
            senderUsername,
            senderPhoto,
            replyTo: replyTo ? replyTo._id : undefined,
          },
        },
      ]);
      console.log('Message marked as failed:', clientMessageId);
    }
  }, [
    message,
    selectedChat,
    userId,
    socket,
    dispatch,
    encryptMessage,
    getPublicKey,
    virtualNumber,
    username,
    photo,
    replyTo,
    pendingMessages,
    chats,
  ]);

  const handleEditMessage = useCallback(
    async (messageId, newContent) => {
      if (!newContent.trim() || !selectedChat || !isValidObjectId(selectedChat)) {
        setError('Cannot edit empty message or invalid chat');
        console.warn('Invalid edit:', { newContent, selectedChat });
        return;
      }
      try {
        const recipientPublicKey = await getPublicKey(selectedChat);
        const encryptedContent = await encryptMessage(newContent, recipientPublicKey);

        socket.emit('editMessage', { messageId, newContent: encryptedContent, plaintextContent: newContent }, async (ack) => {
          if (ack?.error) {
            console.error('Edit message error:', ack.error);
            setError(`Failed to edit message: ${ack.error}`);
            return;
          }
          const { message: updatedMessage } = ack;
          dispatch(
            replaceMessage({
              recipientId: selectedChat,
              message: { ...updatedMessage, content: newContent },
              replaceId: messageId,
            })
          );
          await saveMessages([{ ...updatedMessage, content: newContent }]);
          console.log('Message edited successfully:', messageId);
        });

        setEditingMessage(null);
        setMessage('');
        inputRef.current?.focus();
      } catch (err) {
        console.error('Edit message error:', err);
        setError('Failed to edit message');
      }
    },
    [selectedChat, socket, dispatch, encryptMessage, getPublicKey]
  );

  const handleDeleteMessage = useCallback(
    async (messageId) => {
      if (!selectedChat || !isValidObjectId(selectedChat)) {
        setError('Invalid chat');
        console.warn('Invalid chat for delete:', selectedChat);
        return;
      }
      try {
        socket.emit('deleteMessage', { messageId, recipientId: selectedChat }, async (ack) => {
          if (ack?.error) {
            console.error('Delete message error:', ack.error);
            setError(`Failed to delete message: ${ack.error}`);
            return;
          }
          dispatch(deleteMessage({ recipientId: selectedChat, messageId }));
          await saveMessages(chats[selectedChat]?.filter((msg) => msg._id !== messageId) || []);
          console.log('Message deleted successfully:', messageId);
        });
      } catch (err) {
        console.error('Delete message error:', err);
        setError('Failed to delete message');
      }
    },
    [selectedChat, socket, dispatch, chats]
  );

  const handleTyping = useCallback(
    debounce(() => {
      if (!selectedChat || !message.trim() || !isValidObjectId(selectedChat)) return;
      socket.emit('typing', { userId, recipientId: selectedChat });
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(
        () => socket.emit('stopTyping', { userId, recipientId: selectedChat }),
        2000
      );
    }, 500),
    [selectedChat, userId, socket, message]
  );

  const handleScroll = useCallback(
    ({ scrollTop, scrollHeight, clientHeight }) => {
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10;
      isAtBottomRef.current = isAtBottom;
      setShowJumpToBottom(!isAtBottom && (chats[selectedChat]?.length || 0) > 20);
    },
    [selectedChat, chats]
  );

  const jumpToBottom = useCallback(() => {
    if (chats[selectedChat]?.length > 0) {
      listRef.current?.scrollToRow(chats[selectedChat].length - 1);
      setShowJumpToBottom(false);
      console.log('Jumped to bottom');
    }
  }, [selectedChat, chats]);

  const handleSwipe = useCallback(
    (msg) => {
      setReplyTo(msg);
      inputRef.current?.focus();
      console.log('Swiped to reply:', msg._id);
    },
    []
  );

  useEffect(() => {
    const initializeChat = async () => {
      try {
        await fetchChatList();
        const pending = await loadPendingMessages();
        setPendingMessages(Array.isArray(pending) ? pending : []);
        if (selectedChat && !chats[selectedChat]) {
          dispatch(setMessages({ recipientId: selectedChat, messages: [] }));
          await fetchMessages(selectedChat);
        }
      } catch (err) {
        console.error('Chat initialization error:', err);
        if (err.name === 'VersionError') {
          console.warn('IndexedDB VersionError, clearing database');
          await clearDatabase();
          setPendingMessages([]);
          await fetchChatList();
        } else {
          setError('Failed to initialize chat');
        }
      }
      const interval = setInterval(() => sendPendingMessages().catch((err) => console.error('Failed to send pending messages:', err)), 5000);
      return () => clearInterval(interval);
    };
    initializeChat();
  }, [fetchChatList, sendPendingMessages, selectedChat, chats, dispatch, fetchMessages]);

  useEffect(() => {
    if (selectedChat && !chats[selectedChat] && isValidObjectId(selectedChat)) {
      initializeChat(selectedChat);
      fetchMessages(selectedChat);
    }
  }, [selectedChat, fetchMessages, initializeChat, chats]);

  useEffect(() => {
    if (!socket || !userId) return;

    const handleMessage = async (msg) => {
      try {
        if (!msg?.clientMessageId || !msg?.recipientId || !msg?.senderId || !isValidObjectId(msg.recipientId) || !isValidObjectId(msg.senderId)) {
          console.warn('Invalid message received:', msg);
          return;
        }

        const recipientId = msg.senderId === userId ? msg.recipientId : msg.senderId;
        if (!chats[recipientId] && selectedChat !== recipientId) {
          dispatch(setMessages({ recipientId, messages: [] }));
        }

        if (chats[recipientId]?.some((m) => m.clientMessageId === msg.clientMessageId)) {
          console.warn('Duplicate message:', msg.clientMessageId);
          return;
        }

        const privateKeyPem = localStorage.getItem('privateKey') || '';
        let decryptedContent = msg.content;

        if (msg.contentType === 'text' && msg.recipientId === userId && privateKeyPem) {
          decryptedContent = await decryptMessage(msg.content, privateKeyPem);
        } else if (msg.contentType !== 'text') {
          decryptedContent = msg.content;
        } else {
          decryptedContent = '[Invalid message]';
        }

        const newMessage = { ...msg, content: decryptedContent };
        dispatch(addMessage({ recipientId, message: newMessage }));
        await saveMessages([newMessage]);
        console.log('Received and added message:', newMessage._id);

        if (msg.recipientId === userId && selectedChat === msg.senderId && isAtBottomRef.current) {
          listRef.current?.scrollToRow(chats[recipientId]?.length || 0);
          socket.emit('batchMessageStatus', {
            messageIds: [msg._id],
            status: 'read',
            recipientId: msg.senderId,
          });
          console.log('Marked message as read:', msg._id);
        }
      } catch (err) {
        console.error('Handle message error:', err);
        setError('Failed to process message');
      }
    };

    const handleEditMessage = async (updatedMessage) => {
      try {
        if (!updatedMessage || !selectedChat || !isValidObjectId(selectedChat)) {
          console.warn('Invalid edit message:', updatedMessage);
          return;
        }

        const privateKeyPem = localStorage.getItem('privateKey') || '';
        let decryptedContent = updatedMessage.content;

        if (updatedMessage.contentType === 'text' && updatedMessage.recipientId === userId && privateKeyPem) {
          decryptedContent = await decryptMessage(updatedMessage.content, privateKeyPem);
        }

        dispatch(replaceMessage({
          recipientId: selectedChat,
          message: { ...updatedMessage, content: decryptedContent },
          replaceId: updatedMessage._id,
        }));
        await saveMessages([{ ...updatedMessage, content: decryptedContent }]);
        console.log('Edited message:', updatedMessage._id);
      } catch (err) {
        console.error('Handle edit message error:', err);
        setError('Failed to process edited message');
      }
    };

    const handleDeleteMessage = async ({ messageId, recipientId }) => {
      try {
        if (!messageId || !recipientId || !isValidObjectId(recipientId) || !chats[recipientId]) {
          console.warn('Invalid delete message:', { messageId, recipientId });
          return;
        }
        dispatch(deleteMessage({ recipientId, messageId }));
        await saveMessages(chats[recipientId].filter((msg) => msg._id !== messageId));
        console.log('Deleted message:', messageId);
      } catch (err) {
        console.error('Handle delete message error:', err);
        setError('Failed to process deleted message');
      }
    };

    const handleChatListUpdate = ({ users }) => {
      if (Array.isArray(users)) {
        setUsers(users);
        localStorage.setItem('cachedUsers', JSON.stringify(users));
        console.log('Chat list updated via socket');
      }
    };

    socket.on('message', handleMessage);
    socket.on('editMessage', handleEditMessage);
    socket.on('deleteMessage', handleDeleteMessage);
    socket.on('typing', ({ userId: typerId }) => setIsTyping((prev) => ({ ...prev, [typerId]: true })));
    socket.on('stopTyping', ({ userId: typerId }) => setIsTyping((prev) => ({ ...prev, [typerId]: false })));
    socket.on('messageStatus', ({ messageId, status }) => {
      if (selectedChat && messageId) {
        dispatch(updateMessageStatus({ recipientId: selectedChat, messageId, status }));
        console.log(`Message status updated: ${messageId} to ${status}`);
      }
    });
    socket.on('newContact', ({ contactData }) => {
      if (contactData?.id && isValidObjectId(contactData.id)) {
        setUsers((prev) => {
          if (prev.some((u) => u.id === contactData.id)) return prev;
          const updatedUsers = [...prev, contactData];
          localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
          dispatch(setMessages({ recipientId: contactData.id, messages: [] }));
          console.log('New contact added:', contactData.id);
          return updatedUsers;
        });
      }
    });
    socket.on('chatListUpdated', handleChatListUpdate);
    socket.on('userStatus', ({ userId: statusUserId, status, lastSeen }) => {
      if (statusUserId && isValidObjectId(statusUserId)) {
        setUsers((prev) => {
          const updatedUsers = prev.map((u) => (u.id === statusUserId ? { ...u, status, lastSeen } : u));
          localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
          console.log(`User status updated: ${statusUserId} to ${status}`);
          return updatedUsers;
        });
      }
    });

    return () => {
      socket.off('message', handleMessage);
      socket.off('editMessage', handleEditMessage);
      socket.off('deleteMessage', handleDeleteMessage);
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('messageStatus');
      socket.off('newContact');
      socket.off('chatListUpdated', handleChatListUpdate);
      socket.off('userStatus');
    };
  }, [socket, selectedChat, userId, dispatch, decryptMessage, chats]);

  useEffect(() => {
    if (selectedChat && chats[selectedChat]?.length > 0 && isValidObjectId(selectedChat)) {
      const unreadMessages = chats[selectedChat].filter(
        (msg) => msg.recipientId === userId && msg.status !== 'read'
      );
      setUnreadCount(unreadMessages.length);
      setFirstUnreadMessageId(unreadMessages[0]?._id || null);
      if (isAtBottomRef.current && unreadMessages.length > 0) {
        socket.emit('batchMessageStatus', {
          messageIds: unreadMessages.map((msg) => msg._id),
          status: 'read',
          recipientId: selectedChat,
        });
        console.log(`Marked ${unreadMessages.length} messages as read`);
      }
    }
  }, [chats, selectedChat, socket, userId]);

  const getRowHeight = useCallback(
    ({ index }) => {
      const messages = chats[selectedChat] || [];
      const msg = messages[index];
      if (!msg) {
        console.warn(`No message at index ${index} for selectedChat ${selectedChat}`);
        return 100;
      }
      const baseHeight = 60;
      const contentHeight =
        msg.contentType === 'text' ? Math.min((msg.content?.length || 0) / 50, 4) * 20 : 200;
      const replyHeight = msg.replyTo ? 40 : 0;
      const captionHeight = msg.caption ? 20 : 0;
      return baseHeight + contentHeight + replyHeight + captionHeight;
    },
    [chats, selectedChat]
  );

  const renderMessage = useCallback(
    ({ index, key, style }) => {
      if (!selectedChat || !chats[selectedChat] || !Array.isArray(chats[selectedChat])) {
        console.warn('Invalid chat state:', { selectedChat, chats: chats[selectedChat] });
        return <div key={key} style={style} />;
      }
      const messages = chats[selectedChat];
      if (!messages[index]) {
        console.warn(`No message at index ${index} for selectedChat ${selectedChat}`);
        return <div key={key} style={style} />;
      }
      const msg = messages[index];
      const prevMsg = index > 0 ? messages[index - 1] : null;
      const isMine = msg.senderId === userId;
      const showDate = !prevMsg || formatDateHeader(prevMsg.createdAt) !== formatDateHeader(msg.createdAt);
      const isFirstUnread = msg._id === firstUnreadMessageId;

      const swipeHandlers = useSwipeable({
        onSwipedRight: () => isMine && handleSwipe(msg),
        onSwipedLeft: () => !isMine && handleSwipe(msg),
        delta: 50,
        preventDefaultTouchmoveEvent: true,
      });

      return (
        <div key={msg._id || msg.clientMessageId || key} style={style} className="message-container" {...swipeHandlers}>
          {showDate && (
            <div className="date-header">
              <span>{formatDateHeader(msg.createdAt)}</span>
            </div>
          )}
          {isFirstUnread && (
            <div className="unread-divider">
              <span>New Messages</span>
            </div>
          )}
          <div className={`message ${isMine ? 'mine' : 'other'} ${replyTo?._id === msg._id ? 'swiped' : ''}`}>
            {msg.replyTo && (
              <div className="reply-preview">
                <p>{msg.replyTo.content?.slice(0, 50) || '[Content unavailable]'}</p>
              </div>
            )}
            {msg.contentType === 'text' && <p className="message-content">{msg.content || '[Empty message]'}</p>}
            {msg.contentType === 'image' && (
              <img src={msg.content} alt="Sent image" className="message-media" onError={() => console.error(`Failed to load image: ${msg.content}`)} />
            )}
            {msg.contentType === 'video' && (
              <video controls className="message-media">
                <source src={msg.content} type="video/mp4" />
              </video>
            )}
            {msg.contentType === 'audio' && (
              <audio controls className="message-audio">
                <source src={msg.content} type="audio/mpeg" />
              </audio>
            )}
            {msg.contentType === 'document' && (
              <a href={msg.content} target="_blank" rel="noopener noreferrer" className="message-document">
                <FaFileAlt className="mr-2" /> {msg.originalFilename || 'Document'}
              </a>
            )}
            {msg.caption && <p className="message-caption">{msg.caption}</p>}
            <div className="message-meta">
              <span>{formatTime(msg.createdAt)}</span>
              {isMine && (
                <span className="message-status">
                  {msg.status === 'pending'
                    ? 'Sending...'
                    : msg.status === 'sent'
                    ? '✓'
                    : msg.status === 'delivered'
                    ? '✓✓'
                    : msg.status === 'read'
                    ? '✓✓'
                    : 'Failed'}
                </span>
              )}
            </div>
            {msg.status === 'uploading' && (
              <div className="upload-progress">
                <div style={{ width: `${uploadProgress[msg._id] || 0}%` }} />
              </div>
            )}
            {isMine && msg.status !== 'uploading' && (
              <div className="message-actions">
                <FaReply className="action-icon" onClick={() => setReplyTo(msg)} />
                <FaEdit className="action-icon" onClick={() => {
                  setEditingMessage(msg);
                  setMessage(msg.content || '');
                  inputRef.current?.focus();
                }} />
                <FaTrash className="action-icon" onClick={() => handleDeleteMessage(msg._id)} />
              </div>
            )}
          </div>
        </div>
      );
    },
    [selectedChat, chats, userId, firstUnreadMessageId, uploadProgress, handleDeleteMessage, replyTo, handleSwipe]
  );

  const chatListRowRenderer = useCallback(
    ({ index, key, style }) => {
      const user = users[index];
      if (!user || !user.id || !isValidObjectId(user.id)) {
        console.warn(`Invalid user at index ${index}:`, user);
        return <div key={key} style={style} />;
      }
      return (
        <div
          key={user.id}
          style={style}
          className={`chat-list-item ${selectedChat === user.id ? 'selected' : ''}`}
          onClick={() => {
            initializeChat(user.id);
            dispatch(setSelectedChat(user.id));
            fetchMessages(user.id);
            console.log('Selected chat:', user.id);
          }}
        >
          <img src={user.photo} alt={user.username} className="chat-list-avatar" />
          <div className="chat-list-info">
            <div className="chat-list-header">
              <span className="chat-list-username">{user.username}</span>
              {user.latestMessage && (
                <span className="chat-list-time">{formatChatListDate(user.latestMessage.createdAt)}</span>
              )}
            </div>
            <div className="chat-list-preview">{user.latestMessage?.content || 'No messages'}</div>
            {user.unreadCount > 0 && (
              <span className="chat-list-unread">{user.unreadCount}</span>
            )}
            <span className="chat-list-status">{user.status === 'online' ? 'Online' : `Last seen ${formatTime(user.lastSeen)}`}</span>
          </div>
        </div>
      );
    },
    [users, selectedChat, dispatch, initializeChat, fetchMessages]
  );

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showMenu && !event.target.closest('.chat-menu') && !event.target.closest('.menu-dropdown')) {
        setShowMenu(false);
        setMenuTab('');
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showMenu]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        error &&
        !event.target.closest('.error-message') &&
        !event.target.closest('.chat-menu') &&
        !event.target.closest('.menu-dropdown')
      ) {
        setError('');
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [error]);

  return (
    <div className="chat-screen">
      <div className="chat-header">
        <h1>Chat</h1>
        <div className="chat-menu">
          <FaEllipsisH onClick={() => setShowMenu(!showMenu)} />
          <AnimatePresence>
            {showMenu && (
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.8 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                className="menu-dropdown"
              >
                <div
                  className="menu-item"
                  onClick={() => setMenuTab(menuTab === 'add' ? '' : 'add')}
                >
                  <FaUserPlus className="menu-item-icon" /> Add Contact
                </div>
                <div className="menu-item logout" onClick={handleLogout}>
                  <FaSignOutAlt className="menu-item-icon" /> Logout
                </div>
                {menuTab === 'add' && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="menu-add-contact"
                  >
                    <div className="contact-input-group">
                      <input
                        type="text"
                        value={newContactNumber}
                        onChange={(e) => setNewContactNumber(e.target.value)}
                        placeholder="Enter virtual number"
                        className={`contact-input ${error ? 'error' : ''}`}
                      />
                      {newContactNumber && (
                        <FaTimes
                          className="clear-input-icon"
                          onClick={() => setNewContactNumber('')}
                        />
                      )}
                    </div>
                    <button
                      onClick={handleAddContact}
                      className="contact-button"
                      disabled={isAddingContact}
                    >
                      {isAddingContact ? (
                        <span className="loading-spinner">Adding...</span>
                      ) : (
                        'Add Contact'
                      )}
                    </button>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      {error && <div className="error-message">{error}</div>}
      <div className="chat-content">
        {!selectedChat ? (
          <div className="chat-list">
            <AutoSizer>
              {({ width, height }) => (
                <List
                  width={width}
                  height={height}
                  rowCount={users.length}
                  rowHeight={70}
                  rowRenderer={chatListRowRenderer}
                />
              )}
            </AutoSizer>
          </div>
        ) : (
          <div className="chat-conversation">
            <div className="conversation-header">
              <FaArrowLeft
                className="back-icon"
                onClick={() => dispatch(setSelectedChat(null))}
              />
              <img
                src={users.find((u) => u.id === selectedChat)?.photo || 'default-avatar.png'}
                alt="User"
                className="conversation-avatar"
              />
              <div className="conversation-info">
                <h2>{users.find((u) => u.id === selectedChat)?.username || 'Unknown'}</h2>
                {isTyping[selectedChat] ? (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="typing-indicator"
                  >
                    Typing...
                  </motion.span>
                ) : (
                  <span className="status-indicator">
                    {users.find((u) => u.id === selectedChat)?.status === 'online'
                      ? 'Online'
                      : `Last seen ${formatTime(users.find((u) => u.id === selectedChat)?.lastSeen || new Date())}`}
                  </span>
                )}
              </div>
            </div>
            <div className="conversation-messages" ref={chatRef}>
              {chats[selectedChat] === undefined ? (
                <div className="loading-messages">Loading messages...</div>
              ) : chats[selectedChat]?.length === 0 ? (
                <div className="no-messages">No messages yet. Start chatting!</div>
              ) : (
                <AutoSizer>
                  {({ width, height }) => (
                    <List
                      ref={listRef}
                      width={width}
                      height={height}
                      rowCount={chats[selectedChat]?.length || 0}
                      rowHeight={getRowHeight}
                      rowRenderer={renderMessage}
                      onScroll={handleScroll}
                    />
                  )}
                </AutoSizer>
              )}
              {showJumpToBottom && (
                <button onClick={jumpToBottom} className="jump-to-bottom">
                  <FaArrowDown />
                </button>
              )}
            </div>
            {replyTo && (
              <div className="reply-bar">
                <span>Replying to: {replyTo.content?.slice(0, 50) || '[Content unavailable]'}</span>
                <FaTrash onClick={() => setReplyTo(null)} />
              </div>
            )}
            {mediaPreview.length > 0 && (
              <div className="media-preview">
                {mediaPreview.map((preview, idx) => (
                  <div key={idx} className="media-preview-item">
                    {preview.type === 'image' && (
                      <img src={preview.url} alt="Preview" className="preview-image" />
                    )}
                    {preview.type === 'video' && (
                      <video className="preview-video">
                        <source src={preview.url} type="video/mp4" />
                      </video>
                    )}
                    {preview.type === 'audio' && <audio controls src={preview.url} className="preview-audio" />}
                    <input
                      type="text"
                      placeholder="Add a caption..."
                      value={captions[preview.originalFile.name] || ''}
                      onChange={(e) =>
                        setCaptions((prev) => ({
                          ...prev,
                          [preview.originalFile.name]: e.target.value,
                        }))
                      }
                      className="caption-input"
                    />
                    <FaTrash
                      className="remove-preview"
                      onClick={() => {
                        setMediaPreview((prev) => prev.filter((_, i) => i !== idx));
                        setFiles((prev) => prev.filter((_, i) => i !== idx));
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="input-bar">
              <FaSmile
                className="emoji-icon"
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              />
              {showEmojiPicker && (
                <div className="emoji-picker">
                  <EmojiPicker
                    onEmojiClick={(emoji) => setMessage((prev) => prev + emoji.emoji)}
                  />
                </div>
              )}
              <FaPaperclip
                className="attachment-icon"
                onClick={() => setShowPicker(!showPicker)}
              />
              {showPicker && (
                <div className="attachment-picker">
                  <label className="picker-item">
                    <FaCamera />
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleFileChange(e, 'image')}
                      hidden
                    />
                  </label>
                  <label className="picker-item">
                    <FaVideo />
                    <input
                      type="file"
                      accept="video/*"
                      onChange={(e) => handleFileChange(e, 'video')}
                      hidden
                    />
                  </label>
                  <label className="picker-item">
                    <FaMicrophone />
                    <input
                      type="file"
                      accept="audio/*"
                      onChange={(e) => handleFileChange(e, 'audio')}
                      hidden
                    />
                  </label>
                  <label className="picker-item">
                    <FaFileAlt />
                    <input
                      type="file"
                      onChange={(e) => handleFileChange(e, 'document')}
                      hidden
                    />
                  </label>
                </div>
              )}
              <input
                ref={inputRef}
                type="text"
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  handleTyping();
                }}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    editingMessage
                      ? handleEditMessage(editingMessage._id, message)
                      : sendMessage();
                  }
                }}
                placeholder={editingMessage ? 'Edit message...' : 'Type a message...'}
                className="message-input"
                disabled={!selectedChat}
              />
              <FaPaperPlane
                className="send-icon"
                onClick={() =>
                  editingMessage ? handleEditMessage(editingMessage._id, message) : sendMessage()}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default ChatScreen;