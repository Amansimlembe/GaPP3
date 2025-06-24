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
import { setAuth, clearAuth, setSelectedChat, resetState } from './store';

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
              userId: this.props.userId || null,
              route: window.location.pathname,
              timestamp: new Date().toISOString(),
            },
            { headers: { Authorization: `Bearer ${this.props.token}` }, timeout: 5000 }
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
        <div className="error-screen p-4 text-center bg-gray-100 dark:bg-gray-900 min-h-screen flex flex-col justify-center">
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-200">Something went wrong</h2>
          <p className="my-2 text-gray-600 dark:text-gray-400">{this.state.error?.message || 'Unknown error'}</p>
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

const getTokenExpiration = useCallback((token) => {
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
}, []);

const App = () => {
  const dispatch = useDispatch();
  const { token, userId, role, photo, virtualNumber, username } = useSelector((state) => state.auth);
  const { selectedChat } = useSelector((state) => state.messages);
  const [chatNotifications, setChatNotifications] = useState(0);
  const [socket, setSocket] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
  const [error, setError] = useState(null);

  // Error logging consistent with ChatScreen.js and store.js
  const logError = useCallback(async (message, error) => {
    try {
      await axios.post(
        `${BASE_URL}/social/log-error`,
        {
          error: message,
          stack: error?.stack || '',
          userId: userId || null,
          route: window.location.pathname,
          timestamp: new Date().toISOString(),
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      );
    } catch (err) {
      console.warn('Failed to log error:', err.message);
    }
  }, [token, userId]);

  // Logout handler
  const handleLogout = useCallback(async () => {
    try {
      await axios.post(
        `${BASE_URL}/social/logout`, // Updated to /social/logout
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        }
      );
      if (socket) {
        socket.emit('leave', userId);
        socket.disconnect();
      }
      dispatch(clearAuth());
      dispatch(resetState());
      setSocket(null);
      setChatNotifications(0);
      setError(null);
      localStorage.removeItem('token');
      localStorage.removeItem('userId');
      localStorage.removeItem('username');
      localStorage.removeItem('virtualNumber');
      localStorage.removeItem('photo');
      console.log('Logout successful');
    } catch (error) {
      console.error('Logout error:', error.message);
      logError('Logout failed', error);
      setError('Failed to logout, please try again');
      if (error.response?.status === 401) {
        setTimeout(() => {
          dispatch(clearAuth());
          dispatch(resetState());
          setSocket(null);
          setChatNotifications(0);
          localStorage.clear();
          window.location.href = '/login';
        }, 1000);
      }
    }
  }, [dispatch, token, userId, socket, logError]);

  // Socket initialization
  useEffect(() => {
    if (!token || !userId) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      return;
    }

    const newSocket = io(BASE_URL, {
      auth: { token, userId },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      newSocket.emit('join', { userId });
      console.log('Socket connected:', newSocket.id);
    });

    newSocket.on('connect_error', async (error) => {
      console.error('Socket connect error:', error.message);
      logError('Socket connection failed', error);
      if (error.message.includes('invalid token') || error.message.includes('No token provided')) {
        setError('Authentication error, logging out');
        await handleLogout();
      }
    });

    newSocket.on('disconnect', (reason) => {
      console.warn('Socket disconnected:', reason);
      if (reason === 'io server disconnect' && navigator.onLine) {
        newSocket.connect();
      }
    });

    newSocket.on('message', (msg) => {
      const senderId = typeof msg.senderId === 'object' ? msg.senderId._id : msg.senderId;
      if (msg.recipientId === userId && (!selectedChat || selectedChat !== senderId)) {
        setChatNotifications((prev) => prev + 1);
      }
    });

    newSocket.on('newContact', (contactData) => {
      console.log('New contact:', contactData);
    });

    const handleOnline = () => newSocket.connect();
    const handleOffline = () => console.warn('Offline: Socket disconnected');
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      newSocket.emit('leave', userId);
      newSocket.off('connect');
      newSocket.off('connect_error');
      newSocket.off('disconnect');
      newSocket.off('message');
      newSocket.off('newContact');
      newSocket.disconnect();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      setSocket(null);
    };
  }, [token, userId, selectedChat, handleLogout, logError]);

  // Token refresh
  const refreshToken = useCallback(async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!navigator.onLine) {
          throw new Error('Offline: Cannot refresh token');
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
        localStorage.setItem('token', newToken);
        localStorage.setItem('userId', newUserId);
        localStorage.setItem('username', newUsername || '');
        localStorage.setItem('virtualNumber', newVirtualNumber || '');
        localStorage.setItem('photo', newPhoto || 'https://placehold.co/40x40');
        console.log('Token refreshed');
        return newToken;
      } catch (error) {
        console.error(`Token refresh attempt ${attempt} failed:`, error.response?.data || error.message);
        logError(`Token refresh attempt ${attempt} failed`, error);
        if (attempt < 3 && (error.response?.status === 429 || error.response?.status >= 500 || error.code === 'ECONNABORTED' || !navigator.onLine)) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          continue;
        }
        await handleLogout();
        return null;
      }
    }
  }, [token, userId, dispatch, handleLogout, logError]);

  useEffect(() => {
    if (!token || !userId) return;

    let isRefreshing = false;
    const checkTokenExpiration = async () => {
      if (isRefreshing) return;
      isRefreshing = true;
      try {
        const expTime = getTokenExpiration(token);
        if (expTime && expTime - Date.now() < 10 * 60 * 1000) {
          await refreshToken();
        }
      } catch (err) {
        console.error('Token expiration check failed:', err.message);
        logError('Token expiration check failed', err);
        setError('Authentication error, please log in again');
        handleLogout();
      } finally {
        isRefreshing = false;
      }
    };

    checkTokenExpiration();
    const interval = setInterval(checkTokenExpiration, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [token, userId, refreshToken, handleLogout, logError]);

  // Theme management
  useEffect(() => {
    document.documentElement.className = theme === 'dark' ? 'dark' : '';
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light')), []);

  const handleChatNavigation = useCallback(() => {
    setChatNotifications(0);
    dispatch(setSelectedChat(null));
  }, [dispatch]);

  return (
    <ErrorBoundary token={token} userId={userId}>
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
          onComplete={(newVirtualNumber) => {
            dispatch(setAuth({
              token,
              userId,
              role,
              photo,
              virtualNumber: newVirtualNumber,
              username,
            }));
            localStorage.setItem('virtualNumber', newVirtualNumber);
          }}
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
                username={username}
                virtualNumber={virtualNumber}
                photo={photo}
                socket={socket}
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