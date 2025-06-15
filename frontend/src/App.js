import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate, NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaHome, FaBriefcase, FaComments, FaUser } from 'react-icons/fa';
import axios from 'axios';
import io from 'socket.io-client';
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
    axios.post(`${BASE_URL}/social/log-error`, {
      error: error.message,
      stack: errorInfo.componentStack,
      userId: sessionStorage.getItem('userId') || 'unknown',
      route: window.location.pathname,
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
            className="bg-blue-600 text-white px-4 py-2 rounded"
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
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const base64Url = token.split('.')[1];
    if (!base64Url) return null;
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
    return null;
  }
};

const App = () => {
  const [token, setToken] = useState(sessionStorage.getItem('token') || '');
  const [userId, setUserId] = useState(sessionStorage.getItem('userId') || '');
  const [role, setRole] = useState(Number(sessionStorage.getItem('role')) || 0);
  const [photo, setPhoto] = useState(sessionStorage.getItem('photo') || 'https://placehold.co/40x40');
  const [virtualNumber, setVirtualNumber] = useState(sessionStorage.getItem('virtualNumber') || '');
  const [username, setUsername] = useState(sessionStorage.getItem('username') || '');
  const [chatNotifications, setChatNotifications] = useState(0);
  const [isAuthenticated, setIsAuthenticated] = useState(!!sessionStorage.getItem('token'));
  const [socket, setSocket] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
  const [error, setError] = useState(null);
  const [selectedChat, setSelectedChat] = useState(null);

  const setAuth = useCallback((newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername) => {
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
      sessionStorage.setItem('token', token);
      sessionStorage.setItem('userId', userId);
      sessionStorage.setItem('role', String(role));
      sessionStorage.setItem('photo', photo);
      sessionStorage.setItem('virtualNumber', virtualNumber);
      sessionStorage.setItem('username', username);
      setIsAuthenticated(true);
      setError(null);
    } else {
      sessionStorage.clear();
      setIsAuthenticated(false);
      setChatNotifications(0);
      setSocket(null);
      setError('Authentication failed, please log in again');
    }
  }, []);

  const refreshToken = useCallback(async () => {
    try {
      if (!token || !userId) throw new Error('Missing token or userId');
      const response = await axios.post(
        `${BASE_URL}/auth/refresh`,
        { userId },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      const { token: newToken, userId: newUserId, role: newRole, photo: newPhoto, virtualNumber: newVirtualNumber, username: newUsername, privateKey } = response.data;
      setAuth(newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername);
      if (privateKey) sessionStorage.setItem('privateKey', privateKey);
      setError(null);
      return newToken;
    } catch (error) {
      setAuth('', '', '', '', '', '');
      setError('Session expired, please log in again');
      return null;
    }
  }, [token, userId, setAuth]);

  useEffect(() => {
    const interceptor = axios.interceptors.request.use(
      (config) => {
        if (token && !config.headers.Authorization) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401 && !error.config._retry) {
          error.config._retry = true;
          const newToken = await refreshToken();
          if (newToken) {
            error.config.headers.Authorization = `Bearer ${newToken}`;
            return axios(error.config);
          }
        }
        return Promise.reject(error);
      }
    );

    return () => {
      axios.interceptors.request.eject(interceptor);
      axios.interceptors.response.eject(interceptor);
    };
  }, [token, refreshToken]);

  useEffect(() => {
    if (!token || !userId || typeof token !== 'string' || !isAuthenticated) {
      if (isAuthenticated) setAuth('', '', '', '', '', '');
      return;
    }

    const socketInstance = io(BASE_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 5000,
      timeout: 10000,
    });

    socketInstance.on('connect', () => {
      console.log('Socket connected:', socketInstance.id);
      socketInstance.emit('join', userId);
      setError(null);
    });

    socketInstance.on('connect_error', async (err) => {
      console.warn('Socket connect error:', err.message);
      if (err.message.includes('invalid token') || err.message.includes('No token provided') || err.message.includes('Token invalidated')) {
        const newToken = await refreshToken();
        if (newToken) {
          socketInstance.auth.token = newToken;
          socketInstance.disconnect().connect();
        } else {
          setAuth('', '', '', '', '', '');
        }
      } else {
        setError('Connection error, retrying...');
      }
    });

    socketInstance.on('disconnect', (reason) => {
      console.log('Socket disconnected:', reason);
      if (reason === 'io server disconnect') {
        socketInstance.connect();
      }
    });

    socketInstance.on('message', (msg) => {
      const senderId = typeof msg.senderId === 'object' ? msg.senderId._id.toString() : msg.senderId.toString();
      if (msg.recipientId.toString() === userId && (!selectedChat || selectedChat !== senderId)) {
        setChatNotifications((prev) => prev + 1);
      }
    });

    socketInstance.on('chatListUpdated', () => {
      // Trigger chat list refresh
    });

    setSocket(socketInstance);

    return () => {
      socketInstance.emit('leave', userId);
      socketInstance.disconnect();
    };
  }, [token, userId, isAuthenticated, setAuth, refreshToken]);

  useEffect(() => {
    if (!isAuthenticated || !token || !userId || !socket) return;

    let isRefreshing = false;
    const checkTokenExpiration = async () => {
      if (isRefreshing) return;
      isRefreshing = true;
      try {
        const expTime = getTokenExpiration(token);
        if (expTime && expTime - Date.now() < 15 * 60 * 1000) {
          const newToken = await refreshToken();
          if (newToken) {
            socket.auth.token = newToken;
            socket.disconnect().connect();
          }
        }
      } finally {
        isRefreshing = false;
      }
    };

    checkTokenExpiration();
    const interval = setInterval(checkTokenExpiration, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [isAuthenticated, token, userId, socket, refreshToken]);

  useEffect(() => {
    document.documentElement.className = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  const handleChatNavigation = useCallback(() => {
    if (selectedChat) {
      setChatNotifications(0);
    }
  }, [selectedChat]);

  if (!isAuthenticated) {
    return (
      <ErrorBoundary>
        {error && (
          <div className="fixed top-0 left-0 right-0 bg-blue-600 text-white p-2 text-center">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
          </div>
        )}
        <LoginScreen setAuth={setAuth} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      {error && (
        <div className="fixed top-0 left-0 right-0 bg-blue-600 text-white p-2 text-center">
        {error}
        <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
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
          setSelectedChat={setSelectedChat}
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
  setSelectedChat,
}) => {
  const location = useLocation();

  return (
    <div className={`min-h-screen flex flex-col ${theme === 'light' ? 'bg-gray-100' : 'dark:bg-gray-900'}`}>
      {!virtualNumber && (
        <CountrySelector
          token={token}
          userId={userId}
          virtualNumber={virtualNumber}
          onComplete={(newVirtualNumber) => setAuth(token, userId, role, photo, newVirtualNumber, username)}
        />
      )}
      <div className="flex-1 p-0">
        <Routes>
          <Route path="/jobs" element={role === 0 ? <JobSeekerScreen token={token} userId={userId} /> : <EmployerScreen token={token} userId={userId} />} />
          <Route path="/feed" element={<FeedScreen token={token} userId={userId} socket={socket} onUnauthorized={() => setAuth('', '', '', '', '', '')} />} />
          <Route path="/chat" element={<ChatScreen
            token={token}
            userId={userId}
            setAuth={setAuth}
            socket={socket}
            username={username}
            virtualNumber={virtualNumber}
            photo={photo}
            setSelectedChat={setSelectedChat}
          />} />
          <Route path="/profile" element={<ProfileScreen
            token={token}
            userId={userId}
            setAuth={setAuth}
            username={username}
            virtualNumber={virtualNumber}
            photo={photo}
          />}
          />
          <Route path="/" element={<Navigate to="/feed" replace />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </div>
      <motion.nav
        initial={{ y: 0 }}
        animate={{ y: location.pathname === '/chat' && selectedChat ? '100%' : 0 }}
        transition={{ duration: 0.3 }}
        className="fixed bottom-0 left-0 right-0 bg-blue-600 text-white p-2 flex justify-around items-center shadow-lg z-20"
      >
        <NavLink to="/feed" className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-blue-700' : 'hover:bg-blue-700'}`}>
          <FaHome className="text-xl" />
          <span className="text-xs">Feed</span>
        </NavLink>
        <NavLink to="/jobs" className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-blue-700' : 'hover:bg-blue-700'}`}>
          <FaBriefcase className="text-xl" />
          <span className="text-xs">Jobs</span>
        </NavLink>
        <NavLink
          to="/chat"
          onClick={handleChatNavigation}
          className={({ isActive }) => `flex flex-col items-center p-2 rounded relative ${isActive ? 'bg-blue-700' : 'hover:bg-blue-700'}`}
        >
          <FaComments className="text-xl" />
          {chatNotifications > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
              {chatNotifications}
            </span>
          )}
          <span className="text-xs">Chat</span>
        </NavLink>
        <NavLink to="/profile" className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-blue-700' : 'hover:bg-blue-700'}`}>
          <FaUser className="text-xl" />
          <span className="text-xs">Profile</span>
        </NavLink>
      </motion.nav>
    </div>
  );
};

export default App;