import React, { useState, useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import forge from 'node-forge';
import { List, AutoSizer } from 'react-virtualized';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
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

const generateClientMessageId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const ChatScreen = React.memo(({ token, userId, setAuth, socket, username, virtualNumber, photo }) => {
  const dispatch = useDispatch();
  const { chats, selectedChat } = useSelector((state) => state.messages);
  const selectedChatRef = useRef(selectedChat);
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

  const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

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

  const handleLogout = useCallback(() => {
    dispatch(resetState());
    setAuth(null, null, null, null, null, null, null);
    localStorage.clear();
    clearDatabase();
    setUsers([]);
    setError('Logged out successfully');
  }, [dispatch, setAuth]);

  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

  useEffect(() => {
    const privateKey = localStorage.getItem('privateKey');
    if (!privateKey) {
      console.warn('No private key found in localStorage');
      setError('Private key missing, please log in again');
      handleLogout();
    }
  }, [handleLogout]);

  useEffect(() => {
    if (!socket || !userId) return;

    const handleConnect = () => {
      socket.emit('join', userId);
      console.log('Socket connected:', socket.id);
    };

    const handleMessage = (msg) => {
      if (msg.recipientId === userId && (!selectedChatRef.current || selectedChatRef.current !== msg.senderId)) {
        setChatNotifications((prev) => prev + 1);
      }
      if (msg.senderId === selectedChatRef.current) {
        const privateKeyPem = localStorage.getItem('privateKey');
        decryptMessage(msg.content, privateKeyPem, msg.contentType !== 'text').then((decryptedContent) => {
          dispatch(addMessage({
            recipientId: msg.senderId,
            message: { ...msg, content: decryptedContent || msg.content },
          }));
        });
      }
    };

    const handleNewContact = (contactData) => {
      console.log('New contact:', contactData);
      setUsers((prev) => {
        const updatedUsers = [...prev, contactData];
        localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
        return updatedUsers;
      });
    };

    const handleDisconnect = (reason) => {
      console.warn('Socket disconnected:', reason);
    };

    const handleConnectError = (error) => {
      console.error('Socket connect error:', error.message);
      setError(`Socket connection failed: ${error.message}`);
    };

    socket.on('connect', handleConnect);
    socket.on('message', handleMessage);
    socket.on('newContact', handleNewContact);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('message', handleMessage);
      socket.off('newContact', handleNewContact);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
    };
  }, [socket, userId, dispatch]);

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
    [token, userId, decryptMessage, handleLogout]
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
        } else {
          console.log(`No local messages found for ${recipientId}, fetching from server`);
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
              } else if (msg.senderId !== userId) {
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
            setError('Authentication error, please log out and try again');
            setTimeout(() => handleLogout(), 2000);
            return;
          }
          if (err.response?.status === 429) {
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          }
          if (attempt === retryCount) {
            setError('Failed to load messages');
            dispatch(setMessages({ recipientId, messages: [] }));
            console.warn(`Failed to fetch messages for ${recipientId} after ${retryCount} attempts`);
          }
        }
      }
    }, 500),
    [token, userId, dispatch, decryptMessage, handleLogout]
  );

  const sendPendingMessages = useCallback(async () => {
    if (!navigator.onLine || !pendingMessages.length || !socket?.connected) {
      console.log('Skipping sendPendingMessages: offline, no messages, or socket disconnected');
      return;
    }
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
              reject(new Error(ack.error));
              return;
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
              .then(() => {
                successfulSends.push(tempId);
                resolve();
              })
              .catch((err) => {
                console.error('Failed to save pending message:', err);
                reject(err);
              });
          });
        });
      } catch (err) {
        console.error('Pending message send failed:', err);
      }
    }
    if (successfulSends.length) {
      const updatedPendingMessages = pendingMessages.filter((p) => !successfulSends.includes(p.tempId));
      setPendingMessages(updatedPendingMessages);
      await savePendingMessages(updatedPendingMessages);
      await clearPendingMessages(successfulSends);
      console.log(`Sent ${successfulSends.length} pending messages`);
    }
  }, [pendingMessages, socket, dispatch]);

  const handleFileChange = useCallback(
    async (e, type) => {
      try {
        const currentChatId = selectedChatRef.current;
        if (!e.target.files?.length || !currentChatId || !isValidObjectId(currentChatId)) {
          throw new Error('No files selected, no chat selected, or invalid chat');
        }
        if (!socket || !socket.connected) {
          throw new Error('Socket connection not established');
        }

        const selectedFiles = Array.from(e.target.files);
        const compressedFiles = await Promise.all(
          selectedFiles.map((file) => file.type.startsWith('image/') ? compressImage(file) : file)
        );

        const tempMessages = compressedFiles.map((file) => {
          const clientMessageId = generateClientMessageId();
          return {
            _id: clientMessageId,
            senderId: userId,
            recipientId: currentChatId,
            content: URL.createObjectURL(file),
            contentType: type,
            status: 'pending',
            timestamp: new Date().toISOString(),
            clientMessageId,
            originalFilename: file.name,
            virtualNumber,
            senderUsername: username,
            senderPhoto: photo,
          };
        });

        tempMessages.forEach((msg) => {
          dispatch(addMessage({
            recipientId: currentChatId,
            message: msg,
          }));
        });

        setFiles(compressedFiles);
        setContentType(type);
        setMediaPreview(compressedFiles.map((file) => ({
          type,
          content: URL.createObjectURL(file),
          file,
          caption: captions[file.name] || '',
        })));

        if (isAtBottomRef.current && chats[currentChatId]?.length) {
          listRef.current?.scrollToRow(chats[currentChatId].length);
        }

        for (const [index, file] of compressedFiles.entries()) {
          const clientMessageId = tempMessages[index]._id;
          const formData = new FormData();
          formData.append('file', file);
          formData.append('userId', userId);
          formData.append('recipientId', currentChatId);
          formData.append('clientMessageId', clientMessageId);
          formData.append('senderVirtualNumber', virtualNumber);
          formData.append('senderUsername', username);
          formData.append('senderPhoto', photo);
          if (captions[file.name]) {
            formData.append('caption', captions[file.name]);
          }

          const response = await axios.post(
            `${BASE_URL}/social/upload`,
            formData,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'multipart/form-data',
              },
              onUploadProgress: (e) => {
                const percentCompleted = Math.round((e.loaded * 100) / e.total);
                setUploadProgress((prev) => ({
                  ...prev,
                  [clientMessageId]: percentCompleted,
                }));
                dispatch(
                  updateMessageStatus({
                    messageId: clientMessageId,
                    recipientId: currentChatId,
                    status: 'uploading',
                    uploadProgress: percentCompleted,
                  })
                );
              },
              timeout: 30000,
            }
          );

          const { message: uploadedMessage } = response.data;
          dispatch(
            replaceMessage({
              recipientId: currentChatId,
              message: uploadedMessage,
              replaceId: clientMessageId,
            })
          );
          socket?.emit('messageStatus', {
            id: uploadedMessage._id,
            status: 'sent',
          });
          await saveMessages([uploadedMessage]);
          console.log(`Uploaded file: ${uploadedMessage.originalFilename}`);
        }
      } catch (err) {
        console.error('File upload failed:', err);
        setError(`Upload failed: ${err.message}`);
        dispatch(
          updateMessageStatus({
            messageId: clientMessageId,
            recipientId: currentChatId,
            status: 'failed',
            uploadProgress: 0,
          })
        );
        if (err.response?.status === 401) {
          setError('Session expired, please log in again');
          setTimeout(() => handleLogout(), 1000);
        }
      }

      setFiles([]);
      setMediaPreview([]);
      setCaptions({});
      setMessage('');
      setReplyTo(null);
      inputRef.current?.focus();
    },
    [token, userId, socket, virtualNumber, username, photo, dispatch, chats, compressImage, handleLogout]
  );

  const handleAddContact = useCallback(
    async () => {
      if (!newContactNumber || !newContactNumber.trim()) {
        setError('Please enter a valid virtual number');
        return;
      }

      setIsAddingContact(true);
      try {
        const { data } = await axios.post(
          `${BASE_URL}/social/add_contact`,
          { userId, virtualNumber: newContactNumber.trim() },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 6000 }
        );
        if (!data?.id || !isValidObjectId(data.id)) {
          throw new Error('Invalid contact ID received');
        }

        setUsers((prev) => {
          const updatedUsers = [...prev, {
            id: data.id,
            virtualNumber: newContactNumber,
            username: data.username || '',
            photo: data.photo || '',
          }];
          localStorage.setItem('cachedUsers', JSON.stringify(updatedUsers));
          return updatedUsers;
        });
        setNewContactNumber('');
        setIsAddingContact(false);
        setError(null);
        console.log('Contact added successfully:', data.id);
      } catch (err) {
        console.error('Add contact failed:', err);
        setError(`Failed to add contact: ${err.message}`);
        setIsAddingContact(false);
        if (err.response?.status === 401) {
          setError('Session expired, please log in again');
          setTimeout(() => handleLogout(), 1000);
        }
      }
    },
    [token, userId, newContactNumber, handleLogout]
  );

  useEffect(() => {
    fetchChatList();
    if (selectedChat) {
      fetchMessages(selectedChat);
      initializeChat(selectedChat);
    }
  }, [selectedChat, fetchChatList, fetchMessages, initializeChat]);

  return (
    <div className="chat-screen flex flex-col h-full">
      {error && (
        <div className="bg-red-500 text-white p-2 text-center">
          {error}
          <button
            className="ml-2 bg-white text-red-500 px-2 py-1 rounded"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {!selectedChat ? (
        <div className="chat-list">
          <h2>Chats</h2>
          {users.map((user) => (
            <div
              key={user.id}
              className="p-2 border-b cursor-pointer"
              onClick={() => dispatch(setSelectedChat(user.id))}
            >
              {user.username} ({user.virtualNumber})
            </div>
          ))}
          <input
            type="text"
            value={newContactNumber}
            onChange={(e) => setNewContactNumber(e.target.value)}
            placeholder="Add contact by virtual number"
            className="mt-2 p-2 border rounded"
            disabled={isAddingContact}
          />
          <button
            onClick={handleAddContact}
            disabled={isAddingContact}
            className="mt-2 bg-blue-500 text-white px-4 py-2 rounded"
          >
            Add Contact
          </button>
        </div>
      ) : (
        <div className="chat-messages flex flex-1">
          <div className="flex items-center p-2 border-b">
            <FaArrowLeft
              className="cursor-pointer"
              onClick={() => dispatch(setSelectedChat(null))}
            />
            <span className="ml-2">{users.find((u) => u.id === selectedChat)?.username || 'Chat'}</span>
          </div>
          <div className="messages flex-1 overflow-y-auto">
            <AutoSizer>
              {({ height, width }) => (
                <List
                  ref={listRef}
                  width={width}
                  height={height}
                  rowCount={chats[selectedChat]?.length || 0}
                  rowHeight={60}
                  rowRenderer={({ index, key, style }) => {
                    const msg = chats[selectedChat][index];
                    return (
                      <div key={key} style={style} className="p-2">
                        <p>{msg.content}</p>
                        <span className={msg.senderId === userId ? 'text-right' : 'text-left'}>
                          {formatTime(msg.timestamp)}
                        </span>
                      </div>
                    );
                  }}
                />
              )}
            </AutoSizer>
          </div>
          <div className="input-area flex p-2">
            <input
              ref={inputRef}
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Type a message..."
              className="flex-1 p-1 border rounded"
            />
            <input type="file" id="fileInput" className="hidden" onChange={(e) => handleFileChange(e, 'file')} />
            <label htmlFor="fileInput">
              <FaPaperclip className="ml-2 cursor-pointer" />
            </label>
            <button
              onClick={() => {
                console.log('Sending message:', message);
                setMessage('');
              }}
              className="ml-2 bg-blue-500 text-white px-2 py-1 rounded"
            >
              <FaPaperPlane />
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export default ChatScreen;