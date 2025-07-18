import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaHome, FaBriefcase, FaComments, FaUser } from 'react-icons/fa';
import axios from 'axios';
import io from 'socket.io-client';
import { useSelector, useDispatch } from 'react-redux';
import PropTypes from 'prop-types';
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';
import CountrySelector from './components/CountrySelector';
import { setAuth, clearAuth, setSelectedChat } from './store';
import { replaceMessage, updateMessageStatus } from './store';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.setState({ errorInfo });
    if (error.message.includes('IndexedDB')) {
      this.setState({ error: new Error('Failed to initialize local storage. Some features may be limited.') });
    }
    const retryLog = async (retries = 3, baseDelay = 1000) => {
      for (let i = 0; i < retries; i++) {
        try {
          await axios.post(
            `${BASE_URL}/social/log-error`,
            {
              error: error.message,
              stack: errorInfo.componentStack,
              userId: this.props.userId || null,
              route: window.location.pathname,
              timestamp: new Date().toISOString(),
              component: 'App',
              additionalInfo: JSON.stringify({
                token: !!this.props.userId,
                location: window.location.pathname,
                errorDetails: error.stack || error.message,
              }),
            },
            { timeout: 5000 }
          );
          return;
        } catch (err) {
          if (i < retries - 1) {
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 1000));
            continue;
          }
          console.warn('Failed to log error:', err.message);
        }
      }
    };
    retryLog();
  }

  componentDidUpdate(prevProps) {
    if (this.props.location !== prevProps.location && this.state.hasError) {
      this.setState({ hasError: false, error: null, errorInfo: null });
    }
  }

  handleDismiss = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    return (
      <>
        {this.state.hasError && (
          <div className="fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-500 text-white p-4 rounded-lg shadow-lg z-50 max-w-md w-full">
            <h2 className="text-lg font-semibold">Error</h2>
            <p className="my-2 text-sm">{this.state.error?.message || 'An unexpected error occurred'}</p>
            <button
              className="bg-white text-red-500 px-3 py-1 rounded hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-white"
              onClick={this.handleDismiss}
              aria-label="Dismiss error"
            >
              OK
            </button>
          </div>
        )}
        {this.props.children}
      </>
    );
  }
}

ErrorBoundary.propTypes = {
  userId: PropTypes.string,
  location: PropTypes.object,
  children: PropTypes.node.isRequired,
};

const getTokenExpiration = (token) => {
  try {
    if (!token || typeof token !== 'string' || !token.includes('.')) {
      console.warn('Invalid token format');
      return null;
    }
    const base64Url = token.split('.')[1];
    if (!base64Url) {
      console.warn('Invalid JWT payload');
      return null;
    }
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const decoded = JSON.parse(jsonPayload);
    if (!decoded.exp || isNaN(decoded.exp)) {
      console.warn('Invalid token expiration');
      return null;
    }
    return decoded.exp * 1000;
  } catch (error) {
    console.error('Error decoding token:', error.message);
    return null;
  }
};

const errorLogTimestamps = [];
const maxLogsPerMinute = 5;


const logClientError = async (message, error, userId = null) => {
  const now = Date.now();
  errorLogTimestamps.length = errorLogTimestamps.filter((ts) => now - ts < 60 * 1000).length;
  if (errorLogTimestamps.length >= maxLogsPerMinute) return;
  errorLogTimestamps.push(now);
  for (let i = 0; i < 3; i++) {
    try {
      await axios.post(
        `${BASE_URL}/social/log-error`,
        {
          error: message,
          stack: error?.stack || '',
          userId,
          route: window.location.pathname,
          timestamp: new Date().toISOString(),
          additionalInfo: JSON.stringify({
            navigatorOnline: navigator.onLine,
            currentPath: window.location.pathname,
            errorDetails: error?.stack || error?.message,
            socketConnected: socketRef.current?.connected || false,
            attempt: i + 1,
          }),
        },
        { timeout: 10000 } // Increased timeout for error logging
      );
      return;
    } catch (err) {
      if (i < 2) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 1000));
        continue;
      }
      console.warn('Failed to log error:', err.message);
    }
  }
};



const App = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const { token, userId, role, photo, virtualNumber, username, privateKey } = useSelector((state) => state.auth);
  const { selectedChat } = useSelector((state) => state.messages);
  const [chatNotifications, setChatNotifications] = useState(0);
  const [socket, setSocket] = useState(null);
  const [error, setError] = useState(null);
  const [isNavigating, setIsNavigating] = useState(false);
  const [isAuthLoaded, setIsAuthLoaded] = useState(false);
const [isEmployerView, setIsEmployerView] = useState(role === 1);

  // Refs for socket management
  const socketRef = useRef(null);
  const attemptRef = useRef(0);
  const pingIntervalRef = useRef(null);
  const maxReconnectAttempts = 5;
  const maxDelay = 30000; // 30 seconds

  // Initialize and validate auth state from localStorage
  useEffect(() => {
    const initializeAuth = async () => {
      const storedToken = localStorage.getItem('token');
      const storedUserId = localStorage.getItem('userId');
      const storedRole = localStorage.getItem('role');
      const storedPhoto = localStorage.getItem('photo');
      const storedVirtualNumber = localStorage.getItem('virtualNumber');
      const storedUsername = localStorage.getItem('username');
      const storedPrivateKey = localStorage.getItem('privateKey');

      if (storedToken && storedUserId) {
        const expTime = getTokenExpiration(storedToken);
        if (expTime && expTime < Date.now()) {
          console.warn('Stored token is expired, attempting refresh');
          const newToken = await refreshToken(storedToken, storedUserId);
          if (!newToken) {
            clearLocalStorage();
            dispatch(clearAuth());
            setIsAuthLoaded(true);
            navigate('/login', { replace: true });
            return;
          }
        } else {
          dispatch(setAuth({
            token: storedToken,
            userId: storedUserId,
            role: Number(storedRole) || 0,
            photo: storedPhoto || 'https://via.placeholder.com/64',
            virtualNumber: storedVirtualNumber || null,
            username: storedUsername || null,
            privateKey: storedPrivateKey || null,
          }));
        }
      }
      setIsAuthLoaded(true);
    };

    initializeAuth();
  }, [dispatch, navigate]);

  // Clear sensitive data from localStorage
  const clearLocalStorage = useCallback(() => {
    const sensitiveKeys = [
      'token', 'userId', 'role', 'photo', 'virtualNumber', 'username', 'privateKey',
      ...Object.keys(localStorage).filter((key) => key.startsWith('publicKey:') || key.startsWith('queuedMessage:'))
    ];
    sensitiveKeys.forEach((key) => localStorage.removeItem(key));
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      if (socketRef.current) {
        socketRef.current.emit('leave', userId);
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      if (token) {
        await axios.post(
          `${BASE_URL}/auth/logout`,
          { userId },
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
          }
        );
      }
      clearLocalStorage();
      dispatch(clearAuth());
      setChatNotifications(0);
      setSocket(null);
      setIsNavigating(true);
      navigate('/login', { replace: true });
    } catch (err) {
      console.error('Logout failed:', err.message);
      logClientError('Logout failed', err, userId);
      clearLocalStorage();
      dispatch(clearAuth());
      setChatNotifications(0);
      setSocket(null);
      setIsNavigating(true);
      navigate('/login', { replace: true });
    }
  }, [userId, token, navigate, dispatch, clearLocalStorage]);




  const refreshToken = useCallback(async (currentToken, currentUserId) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!navigator.onLine) {
        throw new Error('Offline: Cannot refresh token');
      }
      if (!currentToken || !currentUserId) {
        throw new Error('Missing token or userId');
      }
      const response = await axios.post(
        `${BASE_URL}/auth/refresh`,
        { userId: currentUserId },
        {
          headers: { Authorization: `Bearer ${currentToken}` },
          timeout: 10000, // Increased timeout
        }
      );
      const { token: newToken, userId: newUserId, role: newRole, virtualNumber, username, photo, privateKey } = response.data;
      dispatch(setAuth({
        token: newToken,
        userId: newUserId,
        role: Number(newRole) || 0,
        photo: photo || 'https://via.placeholder.com/64',
        virtualNumber: virtualNumber || null,
        username: username || null,
        privateKey: privateKey || null,
      }));
      localStorage.setItem('token', newToken);
      localStorage.setItem('userId', newUserId);
      localStorage.setItem('role', newRole || '0');
      localStorage.setItem('photo', photo || 'https://via.placeholder.com/64');
      localStorage.setItem('virtualNumber', virtualNumber || '');
      localStorage.setItem('username', username || '');
      localStorage.setItem('privateKey', privateKey || '');
      console.log('Token refresh successful:', { userId: newUserId, role: newRole });
      return newToken;
    } catch (error) {
      console.error(`Token refresh attempt ${attempt} failed: ${error.message}`, error.response?.data);
      logClientError(`Token refresh failed: ${attempt}`, error, currentUserId);
      if (error.response?.status === 404) {
        console.error('Token refresh endpoint not found. Please check server configuration.');
        setError('Authentication service unavailable. Please log in again.');
        return null;
      }
      if (attempt < 3 && (error.response?.status === 429 || error.response?.status >= 500 || error.code === 'ECONNABORTED' || !navigator.onLine)) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        continue;
      }
      return null;
    }
  }
}, [dispatch]);






  useEffect(() => {
    if (isNavigating && location.pathname === '/login') {
      setIsNavigating(false);
      return;
    }

    if (!token || !userId) {
      return;
    }





    // Inside the connectSocket function, replace the entire socket event handling section
const connectSocket = (attempt = 0) => {
  if (socketRef.current || !navigator.onLine || attempt > maxReconnectAttempts) {
    if (attempt > maxReconnectAttempts) {
      setError('Failed to connect to server after retries');
      logClientError('Max socket reconnect attempts reached', new Error('Socket connection failed'), userId);
    }
    return () => {};
  }

  const connect = async () => {
    const expTime = getTokenExpiration(token);
    if (expTime && expTime < Date.now() + 60 * 1000) {
      const newToken = await refreshToken(token, userId);
      if (!newToken) {
        setError('Authentication error, please try again later');
        await handleLogout();
        return () => {};
      }
    }

    const newSocket = io(BASE_URL, {
      auth: { token, userId },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: maxReconnectAttempts,
      reconnectionDelay: 1000,
      reconnectionDelayMax: maxDelay,
      randomizationFactor: 0.5,
      timeout: 10000,
    });

    socketRef.current = newSocket;

    const handleConnect = () => {
      console.log('Socket connected successfully');
      newSocket.emit('join', userId);
      attemptRef.current = 0;
      setError(null);
      setSocket(newSocket);

      // Replay queued messages
      const queuedMessages = Object.keys(localStorage)
        .filter((key) => key.startsWith('queuedMessage:'))
        .map((key) => JSON.parse(localStorage.getItem(key)));
      if (queuedMessages.length > 0) {
        console.log('Replaying queued messages:', queuedMessages.length);
        const sendMessageWithRetry = async (messageData, attempt = 1) => {
          newSocket.emit('message', {
            senderId: messageData.senderId,
            recipientId: messageData.recipientId,
            content: messageData.content || '',
            contentType: messageData.contentType || 'text',
            clientMessageId: messageData.clientMessageId,
            senderVirtualNumber: messageData.senderVirtualNumber,
            senderUsername: messageData.senderUsername,
            senderPhoto: messageData.senderPhoto,
          }, async (ack) => {
            if (ack?.error) {
              console.error(`Failed to send queued message (attempt ${attempt}): ${ack.error}`);
              if (ack.error.includes('Unauthorized') && attempt < 3) {
                const newToken = await refreshToken(token, userId);
                if (!newToken) {
                  setError('Authentication error, please try again later');
                  await handleLogout();
                  return;
                }
                setTimeout(() => sendMessageWithRetry(messageData, attempt + 1), 1000 * attempt);
              } else {
                dispatch(updateMessageStatus({ 
                  recipientId: messageData.recipientId, 
                  messageId: messageData.clientMessageId, 
                  status: 'failed' 
                }));
              }
            } else {
              dispatch(replaceMessage({ 
                recipientId: messageData.recipientId, 
                message: { ...ack.message, plaintextContent: messageData.plaintextContent }, 
                replaceId: messageData.clientMessageId 
              }));
              dispatch(updateMessageStatus({ 
                recipientId: messageData.recipientId, 
                messageId: ack.message._id, 
                status: 'sent' 
              }));
              localStorage.removeItem(`queuedMessage:${messageData.clientMessageId}`);
            }
          });
        };

        queuedMessages.forEach((messageData, index) => {
          setTimeout(() => sendMessageWithRetry(messageData), index * 500);
        });
      }

      // Request chat list update on connect
      newSocket.emit('requestChatList', { userId });

      pingIntervalRef.current = setInterval(() => {
        if (newSocket.connected) {
          newSocket.emit('ping', { userId });
          console.log('Ping sent to server');
        }
      }, 30000);
    };

    const handleConnectError = async (error) => {
      console.error('Socket connect error:', error.message);
      logClientError('Socket connect error', error, userId);
      if (error.message.includes('invalid token') || error.message.includes('No token provided')) {
        setError('Session expired. Attempting to reconnect...');
        const newToken = await refreshToken(token, userId);
        if (!newToken) {
          setError('Authentication error, please try again later');
          await handleLogout();
        } else {
          connectSocket(attempt + 1);
        }
      } else if (error.message.includes('xhr poll error') || error.message.includes('timeout')) {
        setError('Server is temporarily unavailable. Retrying...');
        attemptRef.current = attempt + 1;
        const delay = Math.min(Math.pow(2, attempt) * 1000 * (1 + Math.random() * 0.2), maxDelay);
        setTimeout(() => connectSocket(attempt + 1), delay);
      } else {
        setError('Failed to connect to server. Please check your connection.');
        attemptRef.current = attempt + 1;
        const delay = Math.min(Math.pow(2, attempt) * 1000 * (1 + Math.random() * 0.2), maxDelay);
        setTimeout(() => connectSocket(attempt + 1), delay);
      }
    };

    const handleDisconnect = (reason) => {
      console.warn('Socket disconnected:', reason);
      logClientError(`Socket disconnected: ${reason}`, new Error(reason), userId);
      if (reason === 'io server disconnect' || reason === 'transport close' || reason === 'ping timeout') {
        if (navigator.onLine) {
          console.log(`Attempting to reconnect (attempt ${attemptRef.current + 1}/${maxReconnectAttempts})`);
        } else {
          setError('Offline: Messages and updates will sync when reconnected');
        }
      }
      setSocket(null);
    };

    const handleMessage = (msg) => {
      if (!msg.senderId || !msg.recipientId) {
        console.warn('Invalid message payload:', msg);
        return;
      }
      if (msg.recipientId === userId && (!selectedChat || selectedChat !== msg.senderId)) {
        setChatNotifications((prev) => prev + 1);
      }
    };

    const handleNewContact = (contactData) => {
      if (!contactData?.id) {
        console.warn('Invalid contact data:', contactData);
        return;
      }
      console.log('New contact added:', contactData);
      // Trigger chat list fetch after new contact
      newSocket.emit('requestChatList', { userId });
    };

    const handleChatListUpdated = ({ users, page = 0, limit = 50 }) => {
      console.log('Received chatListUpdated event:', { users, page, limit });
      if (!Array.isArray(users)) {
        console.warn('Invalid chat list data:', users);
        return;
      }
      dispatch(setChatList(users));
    };

    newSocket.on('connect', handleConnect);
    newSocket.on('connect_error', handleConnectError);
    newSocket.on('disconnect', handleDisconnect);
    newSocket.on('message', handleMessage);
    newSocket.on('newContact', handleNewContact);
    newSocket.on('chatListUpdated', handleChatListUpdated);

    const handleOnline = () => {
      if (!socketRef.current || !socketRef.current.connected) {
        console.log('Network online, attempting to reconnect socket');
        newSocket.connect();
      }
    };

    const handleOffline = () => {
      console.warn('Offline: Socket disconnected');
      setError('Offline: Messages and updates will sync when reconnected');
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setSocket(null);
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      newSocket.emit('leave', userId);
      newSocket.off('connect', handleConnect);
      newSocket.off('connect_error', handleConnectError);
      newSocket.off('disconnect', handleDisconnect);
      newSocket.off('message', handleMessage);
      newSocket.off('newContact', handleNewContact);
      newSocket.off('chatListUpdated', handleChatListUpdated);
      newSocket.disconnect();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      socketRef.current = null;
      setSocket(null);
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    };
  };

  const timeoutId = setTimeout(() => {
    connect();
  }, attempt * 1000);

  return () => {
    clearTimeout(timeoutId);
  };
};


    const cleanup = connectSocket(0);

    return () => {
      cleanup();
    };
  }, [token, userId, location.pathname, handleLogout, navigate, selectedChat, refreshToken]);

  useEffect(() => {
    if (!token || !userId) return;

    let isRefreshing = false;
    const checkTokenExpiration = async () => {
      if (isRefreshing) return;
      isRefreshing = true;
      try {
        const expTime = getTokenExpiration(token);
        if (expTime && expTime - Date.now() < 5 * 60 * 1000) {
          const newToken = await refreshToken(token, userId);
          if (!newToken) {
            setError('Authentication error, please try again later');
            await handleLogout();
          }
        }
      } catch (err) {
        console.error('Token expiration check failed:', err.message);
        logClientError('Token expiration check failed', err, userId);
        setError('Authentication error, please try again later');
        await handleLogout();
      } finally {
        isRefreshing = false;
      }
    };

    checkTokenExpiration();
    const interval = setInterval(checkTokenExpiration, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [token, userId, refreshToken, handleLogout]);

  const handleChatNavigation = useCallback(() => {
    setChatNotifications(0);
    dispatch(setSelectedChat(null));
  }, [dispatch]);

  return (
    <ErrorBoundary userId={userId} location={location}>
      {error && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-500 text-white p-4 rounded-lg shadow-lg z-50 max-w-md w-full">
          <p className="text-sm">{error}</p>
          <button
            className="bg-white text-red-500 px-3 py-1 mt-2 rounded hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-white"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            OK
          </button>
        </div>
      )}
      {!isAuthLoaded ? (
        <div className="min-h-screen flex items-center justify-center text-gray-700 dark:text-gray-300">
          <p>Loading...</p>
        </div>
      ) : (
        <Routes>
          {token && userId ? (
            <Route
              path="*"
              element={
                <AuthenticatedApp
                  token={token}
                  userId={userId}
                  role={role}
                  photo={photo}
                  virtualNumber={virtualNumber}
                  username={username}
                  chatNotifications={chatNotifications}
                  socket={socket}
                  handleChatNavigation={handleChatNavigation}
                  handleLogout={handleLogout}
                />
              }
            />
          ) : (
            <>
              <Route path="/login" element={<LoginScreen />} />
              <Route path="*" element={<Navigate to="/login" replace />} />
            </>
          )}
        </Routes>
      )}
    </ErrorBoundary>
  );
};

const AuthenticatedApp = ({
  token,
  userId,
  role,
  photo,
  virtualNumber,
  username,
  chatNotifications,
  socket,
  handleChatNavigation,
  handleLogout,
}) => {
  const location = useLocation();
  const dispatch = useDispatch();
  const { selectedChat } = useSelector((state) => state.messages);
  const isChatRouteWithSelectedChat = location.pathname === '/chat' && selectedChat;

  if (!location || !dispatch) {
    console.error('AuthenticatedApp: Missing location or dispatch');
    return null;
  }

  return (
    <div className="min-h-screen flex flex-col h-screen bg-gray-100">
      {!virtualNumber && (
        <CountrySelector
          token={token}
          userId={userId}
          virtualNumber={virtualNumber}
          onComplete={(newVirtualNumber) =>
            dispatch(setAuth({ token, userId, role, photo, virtualNumber: newVirtualNumber, username }))
          }
        />
      )}
      <div className="flex-1 p-0 relative">
        
        <Routes>


<Route
  path="/jobs"
  element={
    isEmployerView ? (
      <EmployerScreen
        token={token}
        userId={userId}
        onToggleRole={() => setIsEmployerView(false)}
        onLogout={handleLogout}
      />
    ) : (
      <JobSeekerScreen
        token={token}
        userId={userId}
        onToggleRole={() => setIsEmployerView(true)}
        onLogout={handleLogout}
      />
    )
  }
/>
          <Route
            path="/feed"
            element={<FeedScreen token={token} userId={userId} socket={socket} onLogout={handleLogout} />}
          />
          <Route
            path="/chat"
            element={
              <ChatScreen
                token={token}
                userId={userId}
                socket={socket}
                username={username}
                virtualNumber={virtualNumber}
                photo={photo}
                onLogout={handleLogout}
              />
            }
          />
          <Route
            path="/profile"
            element={
              <ProfileScreen
                token={token}
                userId={userId}
                socket={socket}
                username={username}
                virtualNumber={virtualNumber}
                photo={photo}
                onLogout={handleLogout}
              />
            }
          />
          <Route path="/login" element={<Navigate to="/feed" replace />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </div>
      <motion.nav
        initial={{ y: 0 }}
        animate={{ y: isChatRouteWithSelectedChat ? 200 : 0 }}
        transition={{ duration: 0.3 }}
        className="fixed bottom-0 left-0 right-0 bg-blue-500 text-white p-2 flex justify-around items-center shadow-lg z-20"
      >
        <NavLink
          to="/feed"
          className={({ isActive }) =>
            `flex flex-col items-center p-2 rounded-md ${
              isActive ? 'bg-blue-600' : 'hover:bg-blue-600'
            } focus:outline-none focus:ring-2 focus:ring-white`
          }
          aria-label="Feed"
        >
          <FaHome className="text-xl text-white" />
          <span className="text-xs text-white">Feed</span>
        </NavLink>
        <NavLink
          to="/jobs"
          className={({ isActive }) =>
            `flex flex-col items-center p-2 rounded-md ${
              isActive ? 'bg-blue-600' : 'hover:bg-blue-600'
            } focus:outline-none focus:ring-2 focus:ring-white`
          }
          aria-label="Jobs"
        >
          <FaBriefcase className="text-xl text-white" />
          <span className="text-xs text-white">Jobs</span>
        </NavLink>
        <NavLink
          to="/chat"
          onClick={handleChatNavigation}
          className={({ isActive }) =>
            `flex flex-col items-center p-2 rounded-md relative ${
              isActive ? 'bg-blue-600' : 'hover:bg-blue-600'
            } focus:outline-none focus:ring-2 focus:ring-white`
          }
          aria-label={`Chat ${chatNotifications > 0 ? `with ${chatNotifications} notifications` : ''}`}
        >
          <FaComments className="text-xl text-white" />
          {chatNotifications > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
              {chatNotifications}
            </span>
          )}
          <span className="text-xs text-white">Chat</span>
        </NavLink>
        <NavLink
          to="/profile"
          className={({ isActive }) =>
            `flex flex-col items-center p-2 rounded-md ${
              isActive ? 'bg-blue-600' : 'hover:bg-blue-600'
            } focus:outline-none focus:ring-2 focus:ring-white`
          }
          aria-label="Profile"
        >
          <FaUser className="text-xl text-white" />
          <span className="text-xs text-white">Profile</span>
        </NavLink>
      </motion.nav>
    </div>
  );
};

AuthenticatedApp.propTypes = {
  token: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  role: PropTypes.number.isRequired,
  photo: PropTypes.string,
  virtualNumber: PropTypes.string,
  username: PropTypes.string,
  chatNotifications: PropTypes.number.isRequired,
  socket: PropTypes.object,
  handleChatNavigation: PropTypes.func.isRequired,
  handleLogout: PropTypes.func.isRequired,
};

export default App;