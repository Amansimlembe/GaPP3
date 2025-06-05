import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate, NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaHome, FaBriefcase, FaComments, FaUser } from 'react-icons/fa';
import axios from 'axios';
import io from 'socket.io-client';
import { useSelector } from 'react-redux';
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';
import CountrySelector from './components/CountrySelector';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    // Optionally send error to server for logging
    axios.post(`${BASE_URL}/log-error`, {
      error: error.message,
      stack: errorInfo.componentStack,
      timestamp: new Date().toISOString(),
    }).catch((err) => console.warn('Failed to log error:', err.message));
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-screen p-4 text-center">
          <h2 className="text-xl font-bold">Something went wrong</h2>
          <p className="my-2">{this.state.error?.message || 'Unknown error'}</p>
          <button
            className="bg-primary text-white px-4 py-2 rounded"
            onClick={() => window.location.reload()}
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
    console.error('Error decoding token:', error.message);
    return null;
  }
};


  const App = () => {
  const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id); // Basic ObjectId validation
  const storedToken = localStorage.getItem('token');
  const storedUserId = localStorage.getItem('userId');
  const [token, setToken] = useState(
    storedToken && typeof storedToken === 'string' ? storedToken : ''
  );
  const [userId, setUserId] = useState(
    storedUserId && isValidObjectId(storedUserId) ? storedUserId : ''
  );
  const [role, setRole] = useState(Number(localStorage.getItem('role')) || 0);
  const [photo, setPhoto] = useState(localStorage.getItem('photo') || 'https://placehold.co/40x40');
  const [virtualNumber, setVirtualNumber] = useState(localStorage.getItem('virtualNumber') || '');
  const [username, setUsername] = useState(localStorage.getItem('username') || '');
  const [chatNotifications, setChatNotifications] = useState(0);
  const [isAuthenticated, setIsAuthenticated] = useState(
    storedToken && isValidObjectId(storedUserId)
  );
  const [socket, setSocket] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
  const [error, setError] = useState(null);
  const { selectedChat } = useSelector((state) => state.messages);

  const setAuth = (newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername) => {
    const token = newToken || '';
    const userId = newUserId || '';
    const role = Number(newRole) || 0;
    const photo = newPhoto || 'https://placehold.co/40x40';
    const virtualNumber = newVirtualNumber || '';
    const username = newUsername || '';

    setToken(token);
    setUserId(userId);
    setRole(role);
    setPhoto(photo);
    setVirtualNumber(virtualNumber);
    setUsername(username);

    if (token && userId) {
      localStorage.setItem('token', token);
      localStorage.setItem('userId', userId);
      localStorage.setItem('role', String(role));
      localStorage.setItem('photo', photo);
      localStorage.setItem('virtualNumber', virtualNumber);
      localStorage.setItem('username', username);
      setIsAuthenticated(true);
    } else {
      localStorage.clear();
      setIsAuthenticated(false);
      setChatNotifications(0);
      setSocket(null);
      setError('Authentication failed, please log in again');
    }
  };

  useEffect(() => {
    if (!token || !userId || typeof token !== 'string') {
      console.warn('Invalid token or userId, skipping socket initialization');
      setAuth(null, null, null, null, null, null);
      return;
    }

    const newSocket = io(BASE_URL, {
      auth: { token,
      },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10, // Increased for Render stability
      reconnectionDelay: 3000, // Increased delay
      timeout: 10000, // Increased connection timeout
    });
    setSocket(newSocket);

    return () => {
      newSocket.emit('leave', userId);
      newSocket.disconnect();
      console.log('Socket cleanup');
      setSocket(null);
    };
  }, [token, userId]);

  const refreshToken = async () => {
    try {
      const response = await axios.post(
        `${BASE_URL}/auth/refresh`,
        { userId },
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15000, // Increased timeout
        }
      );
      const { token: newToken, userId: newUserId, role: newRole, photo: newPhoto, virtualNumber: newVirtualNumber, username: newUsername, privateKey } = response.data;
      setAuth(newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername);
      localStorage.setItem('privateKey', privateKey);
      console.log('Token refreshed');
      return newToken;
    } catch (error) {
      console.error('Token refresh failed:', error.response?.data || error.message);
      setAuth(null, null, null, null, null, null);
      setError('Session expired, please log in again');
      return null;
    }
  };

  useEffect(() => {
    if (!isAuthenticated || !token || !userId || !socket) return;

    let isRefreshing = false;
    const checkTokenExpiration = async () => {
      if (isRefreshing) return;
      isRefreshing = true;
      try {
        const expTime = getTokenExpiration(token);
        if (expTime && expTime - Date.now() < 10 * 60 * 1000) { // Check 10 minutes before expiry
          await refreshToken();
        }
      } catch (err) {
        console.error('Token expiration check failed:', err.message);
        setError('Authentication error, please log in again');
      } finally {
        isRefreshing = false;
      }
    };

    checkTokenExpiration();
    const interval = setInterval(checkTokenExpiration, 5 * 60 * 1000); // Check every 5 minutes
    return () => clearInterval(interval);
  }, [isAuthenticated, token, userId, socket]);

  useEffect(() => {
    if (!socket) return;

    socket.on('connect', () => {
      socket.emit('join', userId);
      console.log('Socket connected:', socket.id);
    });

    socket.on('connect_error', async (error) => {
      console.error('Socket connect error:', error.message);
      if (error.message.includes('invalid token') || error.message.includes('No token provided')) {
        const newToken = await refreshToken();
        if (newToken) {
          socket.auth.token = newToken;
          socket.disconnect().connect();
        } else {
          setAuth(null, null, null, null, null, null);
        }
      }
    });

    socket.on('disconnect', (reason) => {
      console.warn('Socket disconnected:', reason);
      if (reason === 'io server disconnect') {
        socket.connect();
      }
    });

    socket.on('message', (msg) => {
      if (msg.recipientId === userId && (!selectedChat || selectedChat !== msg.senderId)) {
        setChatNotifications((prev) => prev + 1);
      }
    });

    socket.on('newContact', (contactData) => {
      console.log('New contact:', contactData);
    });

    return () => {
      socket.off('connect');
      socket.off('connect_error');
      socket.off('disconnect');
      socket.off('message');
      socket.off('newContact');
    };
  }, [socket, userId, selectedChat]);

  useEffect(() => {
    document.documentElement.className = theme === 'dark' ? 'dark' : '';
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');
  const handleChatNavigation = () => setChatNotifications(0);

  if (!isAuthenticated) {
    return (
      <ErrorBoundary>
        {error && (
          <div className="fixed top-0 left-0 right-0 bg-red-500 text-white p-2 text-center">
            {error}
          </div>
        )}
        <LoginScreen setAuth={setAuth} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      {error && (
        <div className="fixed top-0 left-0 right-0 bg-red-500 text-white p-2 text-center">
          {error}
        </div>
      )}
      <Router>
        <AuthenticatedApp
          token={token}
          userId={userId}
          role={role}
          photo={photo}
          virtualNumber={virtualNumber}
          username={username}
          chatNotifications={chatNotifications}
          setAuth={setAuth}
          socket={socket}
          toggleTheme={toggleTheme}
          handleChatNavigation={handleChatNavigation}
          theme={theme}
        />
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
  setAuth,
  socket,
  toggleTheme,
  handleChatNavigation,
  theme,
}) => {
  const location = useLocation();
  const { selectedChat } = useSelector((state) => state.messages);
  const isChatRouteWithSelectedChat = location.pathname === '/chat' && selectedChat;

  return (
    <div className={`min-h-screen flex flex-col ${theme === 'dark' ? 'dark' : ''} bg-gray-100 dark:bg-gray-900`}>
      {!virtualNumber && (
        <CountrySelector
          token={token}
          userId={userId}
          virtualNumber={virtualNumber}
          onComplete={(newVirtualNumber) => setAuth(token, userId, role, photo, newVirtualNumber, username)}
        />
      )}
      <div className="flex-1 p-0 relative">
        <Routes>
          <Route path="/jobs" element={role === 0 ? <JobSeekerScreen token={token} userId={userId} /> : <EmployerScreen token={token} userId={userId} />} />
          <Route path="/feed" element={<FeedScreen token={token} userId={userId} />} />
          <Route path="/chat" element={<ChatScreen token={token} userId={userId} setAuth={setAuth} socket={socket} username={username} virtualNumber={virtualNumber} photo={photo} />} />
          <Route path="/profile" element={<ProfileScreen token={token} userId={userId} setAuth={setAuth} username={username} virtualNumber={virtualNumber} photo={photo} />} />
          <Route path="/" element={<Navigate to="/feed" replace />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </div>
      <motion.nav
        initial={{ y: 0 }}
        animate={{ y: isChatRouteWithSelectedChat ? 200 : 0 }}
        transition={{ duration: 0.3 }}
        className="fixed bottom-0 left-0 right-0 bg-primary text-white p-2 flex justify-around items-center shadow-lg z-20"
      >
        <NavLink to="/feed" className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}>
          <FaHome className="text-xl"/>
          <span className="text-xs">Feed</span>
        </NavLink>
        <NavLink to="/jobs" className="flex flex-col items-center p-2 rounded">
          <FaBriefcase className="text-xl" />
          <span className="text-xs">Jobs</span>
        </NavLink>
        <NavLink
          to="/chat"
          onClick={handleChatNavigation}
          className={({ isActive }) => `flex flex-col items-center p-2 rounded relative ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}
        >
          <FaComments className="text-xl"/>
          {chatNotifications > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
              {chatNotifications}
            </span>
          )}
          <span className="text-xs">Chat</span>
        </NavLink>
        <NavLink to="/profile" className="flex flex-col items-center p-2">
          <FaUser className="text-xl"/>
          <span className="text-xs">Profile</span>
        </NavLink>
      </motion.nav>
    </div>
  );
};

export default App;