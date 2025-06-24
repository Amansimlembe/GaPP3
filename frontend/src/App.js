import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate, NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaHome, FaBriefcase, FaComments, FaUser } from 'react-icons/fa';
import axios from 'axios';
import io from 'socket.io-client';
import { useSelector, useDispatch } from 'react-redux';
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';
import CountrySelector from './components/CountrySelector';
import { setAuth, clearAuth, setSelectedChat } from './store';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    const retryLog = async (retries = 3, baseDelay = 1000) => {
      for (let i = 0; i < retries; i++) {
        try {
          await axios.post(
            `${BASE_URL}/social/log-error`,
            {
              error: error.message,
              stack: errorInfo.componentStack,
              timestamp: new Date().toISOString(),
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

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-screen p-4 text-center">
          <h2 className="text-xl font-bold">Something went wrong</h2>
          <p className="my-2">{this.state.error?.message || 'Unknown error'}</p>
          <button
            className="bg-primary text-white px-4 py-2 rounded focus:outline-none focus:ring-2 focus:ring-primary"
            onClick={() => window.location.reload()}
            aria-label="Reload page"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
    console.warn('Error decoding token:', error.message);
    return null;
  }
};

// Debounce utility for error logging
const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

const App = () => {
  const dispatch = useDispatch();
  const { token, userId, role, photo, virtualNumber, username } = useSelector((state) => state.auth);
  const { selectedChat } = useSelector((state) => state.messages);
  const [chatNotifications, setChatNotifications] = useState(0);
  const [socket, setSocket] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
  const [error, setError] = useState(null);
  const errorLogTimestamps = React.useRef([]);
  const maxLogsPerMinute = 5;

  // Error logging with debouncing
  const logSocketError = useCallback(
    debounce(async (message, errorDetails, userId) => {
      const now = Date.now();
      errorLogTimestamps.current = errorLogTimestamps.current.filter((ts) => now - ts < 60 * 1000);
      if (errorLogTimestamps.current.length >= maxLogsPerMinute) {
        console.warn('Error log rate limit reached');
        return;
      }
      errorLogTimestamps.current.push(now);
      try {
        await axios.post(
          `${BASE_URL}/social/log-error`,
          {
            error: message,
            stack: errorDetails || '',
            userId,
            route: window.location.pathname,
            timestamp: new Date().toISOString(),
          },
          { timeout: 5000 }
        );
      } catch (err) {
        console.warn('Failed to log socket error:', err.message);
      }
    }, 500),
    []
  );

  const handleLogout = useCallback(async () => {
    try {
      if (socket) {
        socket.emit('leave', userId);
        socket.disconnect();
      }
      await axios.post(
        `${BASE_URL}/social/logout`, // Changed to /social/logout
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        }
      );
      dispatch(clearAuth());
      setSocket(null);
      setChatNotifications(0);
      setError(null);
      localStorage.removeItem('theme'); // Preserve theme preference
      sessionStorage.clear();
      localStorage.clear();
      console.log('Logout successful');
    } catch (error) {
      console.warn('Logout error:', error.message);
      setError('Failed to logout, please try again');
      logSocketError('Logout failed', error.message, userId);
      if (error.response?.status === 401) {
        dispatch(clearAuth());
        setSocket(null);
        setChatNotifications(0);
        sessionStorage.clear();
        localStorage.clear();
      }
    }
  }, [dispatch, token, userId, socket, logSocketError]);

  useEffect(() => {
    if (!token || !userId) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      return;
    }

    // Prevent duplicate socket connections
    if (socket) {
      socket.disconnect();
    }

    const newSocket = io(BASE_URL, {
      auth: { token, userId },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 3, // Reduced for free tier
      reconnectionDelay: 2000,
      reconnectionDelayMax: 6000,
      timeout: 8000,
    });
    setSocket(newSocket);

    const handleConnect = () => {
      newSocket.emit('join', { userId });
      console.log('Socket connected:', newSocket.id);
    };

    const handleConnectError = async (error) => {
      console.warn('Socket connect error:', error.message);
      if (error.message.includes('invalid token') || error.message.includes('No token provided')) {
        setError('Authentication error, logging out');
        logSocketError('Socket authentication failed', error.message, userId);
        await handleLogout();
      } else if (!['websocket error', 'ping timeout'].includes(error.message)) {
        logSocketError('Socket connect error', error.message, userId);
      }
    };

    const handleDisconnect = (reason) => {
      console.warn('Socket disconnected:', reason);
      if (reason === 'io server disconnect' && navigator.onLine) {
        newSocket.connect();
      }
    };

    const handleMessage = (msg) => {
      if (msg.recipientId === userId && (!selectedChat || selectedChat !== msg.senderId)) {
        setChatNotifications((prev) => prev + 1);
      }
    };

    const handleNewContact = (contactData) => {
      console.log('New contact:', contactData);
    };

    newSocket.on('connect', handleConnect);
    newSocket.on('connect_error', handleConnectError);
    newSocket.on('disconnect', handleDisconnect);
    newSocket.on('message', handleMessage);
    newSocket.on('newContact', handleNewContact);

    // Online/offline handling
    const handleOnline = () => newSocket.connect();
    const handleOffline = () => console.warn('Offline: Socket disconnected');
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      newSocket.off('connect', handleConnect);
      newSocket.off('connect_error', handleConnectError);
      newSocket.off('disconnect', handleDisconnect);
      newSocket.off('message', handleMessage);
      newSocket.off('newContact', handleNewContact);
      newSocket.emit('leave', userId);
      newSocket.disconnect();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      setSocket(null);
      console.log('Socket cleanup complete');
      errorLogTimestamps.current = [];
    };
  }, [token, userId, selectedChat, handleLogout, logSocketError]);

  const refreshToken = useCallback(async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!navigator.onLine) {
          console.warn('Offline: Cannot refresh token');
          return null;
        }
        const response = await axios.post(
          `${BASE_URL}/auth/refresh`,
          { userId },
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
          }
        );
        const { token: newToken, userId: newUserId, role: newRole, photo: newPhoto, virtualNumber: newVirtualNumber, username: newUsername, privateKey } = response.data;
        dispatch(setAuth({
          token: newToken,
          userId: newUserId,
          role: Number(newRole),
          photo: newPhoto || 'https://placehold.co/40x40',
          virtualNumber: newVirtualNumber || null,
          username: newUsername || null,
          privateKey: privateKey || null,
        }));
        console.log('Token refreshed');
        return newToken;
      } catch (error) {
        console.warn(`Token refresh attempt ${attempt} failed:`, error.message);
        logSocketError(`Token refresh failed (attempt ${attempt})`, error.message, userId);
        if (attempt < 3 && (error.response?.status === 429 || error.response?.status >= 500 || error.code === 'ECONNABORTED' || !navigator.onLine)) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          continue;
        }
        await handleLogout();
        return null;
      }
    }
  }, [token, userId, dispatch, handleLogout, logSocketError]);

  useEffect(() => {
    if (!token || !userId) return;

    let isRefreshing = false;
    let intervalId;
    const checkTokenExpiration = async () => {
      if (isRefreshing) return;
      isRefreshing = true;
      try {
        const expTime = getTokenExpiration(token);
        if (expTime && expTime - Date.now() < 10 * 60 * 1000) {
          await refreshToken();
        }
      } catch (err) {
        console.warn('Token expiration check failed:', err.message);
        setError('Authentication error, please log in again');
        logSocketError('Token expiration check failed', err.message, userId);
        handleLogout();
      } finally {
        isRefreshing = false;
      }
    };

    checkTokenExpiration();
    intervalId = setInterval(checkTokenExpiration, 5 * 60 * 1000);
    return () => {
      clearInterval(intervalId);
      isRefreshing = false;
    };
  }, [token, userId, refreshToken, handleLogout, logSocketError]);

  useEffect(() => {
    document.documentElement.className = theme === 'dark' ? 'dark' : '';
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light')), []);

  const handleChatNavigation = useCallback(() => {
    console.log('Navigating to ChatScreen');
    setChatNotifications(0);
    dispatch(setSelectedChat(null));
  }, [dispatch]);

  return (
    <ErrorBoundary>
      {error && (
        <div className="fixed top-0 left-0 right-0 bg-red-500 text-white p-2 text-center z-50">
          {error}
        </div>
      )}
      <Router>
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
            toggleTheme={toggleTheme}
            handleChatNavigation={handleChatNavigation}
            theme={theme}
            handleLogout={handleLogout}
          />
        ) : (
          <Routes>
            <Route path="/login" element={<LoginScreen />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        )}
      </Router>
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
  toggleTheme,
  handleChatNavigation,
  theme,
  handleLogout,
}) => {
  const location = useLocation();
  const dispatch = useDispatch();
  const { selectedChat } = useSelector((state) => state.messages);
  const isChatRouteWithSelectedChat = location.pathname === '/chat' && selectedChat;

  useEffect(() => {
    console.log('Current route:', location.pathname);
  }, [location.pathname]);

  return (
    <div className={`min-h-screen flex flex-col ${theme === 'dark' ? 'dark' : ''} bg-gray-100 dark:bg-gray-900`}>
      {!virtualNumber && (
        <CountrySelector
          token={token}
          userId={userId}
          virtualNumber={virtualNumber}
          onComplete={(newVirtualNumber) => dispatch(setAuth({ token, userId, role, photo, virtualNumber: newVirtualNumber, username }))}
        />
      )}
      <div className="flex-1 p-0 relative">
        <Routes>
          <Route path="/jobs" element={role === 0 ? <JobSeekerScreen token={token} userId={userId} /> : <EmployerScreen token={token} userId={userId} />} />
          <Route
            path="/feed"
            element={<FeedScreen token={token} userId={userId} onUnauthorized={handleLogout} />}
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
              />
            }
          />
          <Route
            path="/profile"
            element={
              <ProfileScreen
                token={token}
                userId={userId}
                username={username}
                virtualNumber={virtualNumber}
                photo={photo}
                onLogout={handleLogout}
              />
            }
          />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </div>
      <motion.nav
        initial={{ y: 0 }}
        animate={{ y: isChatRouteWithSelectedChat ? 200 : 0 }}
        transition={{ duration: 0.3 }}
        className="fixed bottom-0 left-0 right-0 bg-primary text-white p-2 flex justify-around items-center shadow-lg z-20"
      >
        <NavLink
          to="/feed"
          className={({ isActive }) =>
            `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'} focus:outline-none focus:ring-2 focus:ring-white`
          }
          aria-label="Feed"
        >
          <FaHome className="text-xl" />
          <span className="text-xs">Feed</span>
        </NavLink>
        <NavLink
          to="/jobs"
          className={({ isActive }) =>
            `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'} focus:outline-none focus:ring-2 focus:ring-white`
          }
          aria-label="Jobs"
        >
          <FaBriefcase className="text-xl" />
          <span className="text-xs">Jobs</span>
        </NavLink>
        <NavLink
          to="/chat"
          onClick={handleChatNavigation}
          className={({ isActive }) =>
            `flex flex-col items-center p-2 rounded relative ${isActive ? 'bg-secondary' : 'hover:bg-secondary'} focus:outline-none focus:ring-2 focus:ring-white`
          }
          aria-label={`Chat ${chatNotifications > 0 ? `with ${chatNotifications} notifications` : ''}`}
        >
          <FaComments className="text-xl" />
          {chatNotifications > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
              {chatNotifications}
            </span>
          )}
          <span className="text-xs">Chat</span>
        </NavLink>
        <NavLink
          to="/profile"
          className={({ isActive }) =>
            `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'} focus:outline-none focus:ring-2 focus:ring-white`
          }
          aria-label="Profile"
        >
          <FaUser className="text-xl" />
          <span className="text-xs">Profile</span>
        </NavLink>
      </motion.nav>
    </div>
  );
};

export default App;