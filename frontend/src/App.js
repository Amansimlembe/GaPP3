
import React, { useState, useEffect, useCallback, useRef } from 'react'; // Add useRef
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
import { setAuth, clearAuth, setSelectedChat, resetState } from './store';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.setState({ errorInfo });
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
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * baseDelay));
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
    return decoded.exp ? decoded.exp * 1000 : null;
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
          }),
        },
        { timeout: 5000 }
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
  const { token, userId, role, photo, virtualNumber, username } = useSelector((state) => state.auth);
  const { selectedChat } = useSelector((state) => state.messages);
  const [chatNotifications, setChatNotifications] = useState(0);
  const [socket, setSocket] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
  const [error, setError] = useState(null);
  const [isNavigating, setIsNavigating] = useState(false); // New: Prevent navigation loops
  // Add refs and constants at the top of App.js
const socketRef = useRef(null);
const attemptRef = useRef(0);
const maxReconnectAttempts = 5;
const maxDelay = 30000; // 30 seconds
const handleLogout = useCallback(async () => {
  try {
    if (socketRef.current) {
      socketRef.current.emit('leave', userId);
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    await axios.post(
      `${BASE_URL}/auth/logout`,
      {},
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      }
    );
    sessionStorage.clear();
    localStorage.removeItem('theme'); // Clear theme to prevent leaks
    localStorage.removeItem('username');
    localStorage.removeItem('virtualNumber');
    localStorage.removeItem('photo');
    dispatch(clearAuth());
    dispatch(resetState());
    setChatNotifications(0);
    setSocket(null);
    setIsNavigating(true);
    navigate('/login', { replace: true });
  } catch (err) {
    console.error('Logout failed:', err.message);
    logClientError('Logout failed', err, userId);
    sessionStorage.clear();
    localStorage.removeItem('theme');
    localStorage.removeItem('username');
    localStorage.removeItem('virtualNumber');
    localStorage.removeItem('photo');
    dispatch(clearAuth());
    dispatch(resetState());
    setChatNotifications(0);
    setSocket(null);
    setIsNavigating(true);
    navigate('/login', { replace: true });
  }
}, [userId, token, navigate, dispatch]);
  const refreshToken = useCallback(async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!navigator.onLine) {
          throw new Error('Offline: Cannot refresh token');
        }
        if (!token || !userId) {
          throw new Error('Missing token or userId');
        }
        const response = await axios.post(
          `${BASE_URL}/auth/token`,
          { userId },
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
          }
        );
        const { token: newToken, userId: newUserId, role: newRole, emailIds, virtualNumber, username, photo, privateKey } = response.data;
        dispatch(setAuth({
          token: newToken,
          userId: newUserId,
          role: Number(newRole) || 0,
          emailIds: emailIds || [],
          photo: photo || 'https://via.placeholder.com/64',
          virtualNumber: virtualNumber || null,
          username: username || null,
          privateKey: privateKey || null,
        }));
        console.log('Token refreshed successfully');
        return newToken;
      } catch (error) {
        console.error(`Token refresh attempt ${attempt} failed: ${error.message}`);
        logClientError(`Token refresh failed: ${attempt}`, error, userId);
        if (attempt < 3 && (error.response?.status === 429 || error.response?.status >= 500 || error.code === 'ECONNABORTED' || !navigator.onLine)) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          continue;
        }
        await handleLogout();
        return null;
      }
    }
  }, [dispatch, token, userId, handleLogout]);






  useEffect(() => {
  console.log('App useEffect triggered:', { token, userId, location: location.pathname, isNavigating });

  // Skip if already navigating to /login
  if (isNavigating && location.pathname === '/login') {
    console.log('Skipping effect due to ongoing navigation to /login');
    setIsNavigating(false);
    return;
  }

  // Early return if no token or userId
  if (!token || !userId) {
    if (location.pathname !== '/login' && !isNavigating) {
      console.log('Navigating to /login due to missing token or userId');
      setIsNavigating(true);
      navigate('/login', { replace: true });
    }
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    return;
  }

  // Initialize socket with backoff
  const connectSocket = (attempt = 0) => {
    if (socketRef.current || !navigator.onLine || attempt > maxReconnectAttempts) {
      if (attempt > maxReconnectAttempts) {
        setError('Failed to connect to server after retries');
      }
      return;
    }

    const newSocket = io(BASE_URL, {
      auth: { token, userId },
      transports: ['websocket', 'polling'],
      reconnection: false, // Handle reconnection manually
      timeout: 10000,
    });

    socketRef.current = newSocket;

    const handleConnect = () => {
      newSocket.emit('join', userId);
      console.log('Socket connected:', newSocket.id);
      attemptRef.current = 0; // Reset attempt count
    };

    const handleConnectError = async (error) => {
      console.error('Socket connect error:', error.message);
      logClientError('Socket connect error', error, userId);
      if (error.message.includes('invalid token') || error.message.includes('No token provided')) {
        setError('Authentication error, logging out');
        await handleLogout();
      } else {
        // Exponential backoff
        const delay = Math.min(Math.pow(2, attempt) * 1000, maxDelay);
        console.warn(`Retrying connection in ${delay}ms (attempt ${attempt + 1})`);
        setTimeout(() => connectSocket(attempt + 1), delay);
      }
    };

    const handleDisconnect = (reason) => {
      console.warn('Socket disconnected:', reason);
      logClientError(`Socket disconnected: ${reason}`, new Error(reason), userId);
      if (reason === 'io server disconnect' && navigator.onLine) {
        connectSocket(attemptRef.current + 1);
      }
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
      console.log('New contact:', contactData);
    };

    newSocket.on('connect', handleConnect);
    newSocket.on('connect_error', handleConnectError);
    newSocket.on('disconnect', handleDisconnect);
    newSocket.on('message', handleMessage);
    newSocket.on('newContact', handleNewContact);

    const handleOnline = () => connectSocket(0);
    const handleOffline = () => console.warn('Offline: Socket disconnected');

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    setSocket(newSocket);

    return () => {
      newSocket.emit('leave', userId);
      newSocket.off('connect', handleConnect);
      newSocket.off('connect_error', handleConnectError);
      newSocket.off('disconnect', handleDisconnect);
      newSocket.off('message', handleMessage);
      newSocket.off('newContact', handleNewContact);
      newSocket.disconnect();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      socketRef.current = null;
      console.log('Socket cleanup completed');
    };
  };

  const cleanup = connectSocket(0);

  return () => {
    if (cleanup) cleanup();
  };
}, [token, userId, location.pathname, handleLogout, navigate]);





  useEffect(() => {
    if (!token || !userId) return;

    let isRefreshing = false;
    const checkTokenExpiration = async () => {
      if (isRefreshing) return;
      isRefreshing = true;
      try {
        const expTime = getTokenExpiration(token);
        if (expTime && expTime - Date.now() < 5 * 60 * 1000) {
          await refreshToken();
        }
      } catch (err) {
        console.error('Token expiration check failed:', err.message);
        logClientError('Token expiration check failed', err, userId);
        setError('Authentication error, please log in again');
        await handleLogout();
      } finally {
        isRefreshing = false;
      }
    };

    checkTokenExpiration();
    const interval = setInterval(checkTokenExpiration, 1 * 60 * 1000);
    return () => clearInterval(interval);
  }, [token, userId, refreshToken, handleLogout]);

  const handleChatNavigation = useCallback(() => {
    console.log('Navigating to ChatScreen');
    setChatNotifications(0);
    dispatch(setSelectedChat(null));
  }, [dispatch]);

  // Fallback UI for navigation failure
  if (error && location.pathname !== '/login') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="bg-red-500 text-white p-4 rounded-lg shadow-lg max-w-md w-full">
          <p className="text-sm">{error}</p>
          <button
            className="bg-white text-red-500 px-3 py-1 mt-2 rounded hover:bg-gray-200"
            onClick={() => {
              setError(null);
              setIsNavigating(true);
              navigate('/login', { replace: true });
            }}
            aria-label="Retry login"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

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
      {token && userId ? (
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
      ) : (
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
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

  useEffect(() => {
    console.log('Current route:', location.pathname);
  }, [location.pathname]);

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
            dispatch(setAuthenticity({ token, userId, role, photo, virtualNumber: newVirtualNumber, username }))
          }
        />
      )}
      <div className="flex-1 p-0 relative">
        <Routes>
          <Route
            path="/jobs"
            element={
              role === 0 ? (
                <JobSeekerScreen token={token} userId={userId} onLogout={handleLogout} />
              ) : (
                <EmployerScreen token={token} userId={userId} onLogout={handleLogout} />
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
          <Route path="*" element={<Navigate to="/login" replace />} />
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
  socket: PropTypes.object.isRequired,
  handleChatNavigation: PropTypes.func.isRequired,
  handleLogout: PropTypes.func.isRequired,
};

export default App;