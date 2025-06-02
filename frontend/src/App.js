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

const socket = io(BASE_URL, {
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  randomizationFactor: 0.5,
  withCredentials: true,
  autoConnect: false,
  transports: ['websocket', 'polling'],
  auth: { token: localStorage.getItem('token') },
});

// Updated getTokenExpiration with improved error handling
const getTokenExpiration = (token) => {
  try {
    if (!token || typeof token !== 'string' || !token.includes('.')) {
      console.warn('Invalid token format');
      return null;
    }
    const base64Url = token.split('.')[1];
    if (!base64Url) {
      console.warn('Token payload missing');
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
    if (!decoded.exp) {
      console.warn('Token missing exp claim');
      return null;
    }
    return decoded.exp * 1000;
  } catch (error) {
    console.error('Error decoding token:', error.message);
    return null;
  }
};

const App = () => {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [userId, setUserId] = useState(localStorage.getItem('userId') || '');
  const [role, setRole] = useState(Number(localStorage.getItem('role')) || 0);
  const [photo, setPhoto] = useState(localStorage.getItem('photo') || 'https://placehold.co/40x40');
  const [virtualNumber, setVirtualNumber] = useState(localStorage.getItem('virtualNumber') || '');
  const [username, setUsername] = useState(localStorage.getItem('username') || '');
  const [chatNotifications, setChatNotifications] = useState(0);
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('token'));
  const [isLoadingAuth, setIsLoadingAuth] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
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
      if (!socket.connected) socket.connect();
    } else {
      localStorage.clear();
      socket.emit('leave', userId);
      socket.disconnect();
      setIsAuthenticated(false);
      setChatNotifications(0);
    }
  };

  // Updated refreshToken to handle 401 errors after retries
  const refreshToken = async () => {
    const maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        console.log(`Refresh token attempt ${attempt + 1}`);
        const response = await axios.post(
          `${BASE_URL}/auth/refresh`,
          { userId },
          {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 10000,
            withCredentials: true,
          }
        );
        const { token: newToken, userId: newUserId, role: newRole, photo: newPhoto, virtualNumber: newVirtualNumber, username: newUsername, privateKey } = response.data;
        setAuth(newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername);
        localStorage.setItem('privateKey', privateKey);
        console.log('Token refreshed successfully');
        return newToken;
      } catch (error) {
        attempt++;
        console.error(`Token refresh attempt ${attempt} failed:`, error.response?.data || error.message);
        if (error.response?.status === 429) {
          console.warn('Rate limit hit, waiting before retry');
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt * 5));
        } else if (attempt === maxRetries) {
          console.warn('Token refresh failed after max attempts, clearing auth');
          setAuth('', '', '', '', '', '');
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  };

  // Updated useEffect with delayed initial token check
  useEffect(() => {
    if (!isAuthenticated || !token || !userId) return;

    let isRefreshing = false;
    const checkTokenExpiration = async () => {
      if (isRefreshing) return;
      isRefreshing = true;
      try {
        const expTime = getTokenExpiration(token);
        const now = Date.now();
        const bufferTime = 5 * 60 * 1000;

        if (expTime && expTime - now < bufferTime) {
          const newToken = await refreshToken();
          if (!newToken) console.warn('Periodic token refresh failed');
        }
      } finally {
        isRefreshing = false;
      }
    };

    // Delay initial check to avoid race condition
    const initialCheck = setTimeout(checkTokenExpiration, 5000); // Wait 5 seconds
    const interval = setInterval(checkTokenExpiration, 60 * 1000);
    return () => {
      clearTimeout(initialCheck);
      clearInterval(interval);
    };
  }, [isAuthenticated, token, userId]);

  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;
        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;
          const newToken = await refreshToken();
          if (newToken) {
            originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
            return axios(originalRequest);
          }
        }
        return Promise.reject(error);
      }
    );
    return () => axios.interceptors.response.eject(interceptor);
  }, [token]);

  useEffect(() => {
    document.documentElement.className = theme === 'dark' ? 'dark' : '';
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!isAuthenticated || !token || !userId) return;

    socket.on('connect', () => {
      socket.emit('join', userId);
      console.log('Socket connected:', socket.id);
    });

    socket.on('connect_error', (error) => console.error('Socket connection error:', error.message));
    socket.on('reconnect_attempt', (attempt) => console.log(`Reconnection attempt #${attempt}`));
    socket.on('reconnect_failed', () => {
      console.error('Reconnection failed after max attempts');
      setAuth('', '', '', '', '', '');
    });
    socket.on('disconnect', (reason) => console.log('Socket disconnected:', reason));

    socket.on('message', (msg) => {
      if (msg.recipientId === userId && (!selectedChat || selectedChat !== msg.senderId)) {
        setChatNotifications((prev) => prev + 1);
      }
    });

    socket.on('newContact', (contactData) => console.log('New contact added via socket:', contactData));

    return () => {
      socket.off('connect');
      socket.off('connect_error');
      socket.off('reconnect_attempt');
      socket.off('reconnect_failed');
      socket.off('message');
      socket.off('newContact');
      socket.off('disconnect');
    };
  }, [isAuthenticated, userId, token, selectedChat]);

  const toggleTheme = () => setTheme((prevTheme) => (prevTheme === 'light' ? 'dark' : 'light'));
  const handleChatNavigation = () => setChatNotifications(0);

  // Render LoginScreen instantly if not authenticated and no token
  if (!isAuthenticated && !localStorage.getItem('token')) {
    return <LoginScreen setAuth={setAuth} />;
  }

  // Render nothing during auth check to avoid flicker
  if (isLoadingAuth) {
    return null;
  }

  return (
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
        setTheme={setTheme}
        selectedChat={selectedChat}
      />
    </Router>
  );
};

// Separate component for authenticated routes to use useLocation
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
  setTheme,
  selectedChat,
}) => {
  const location = useLocation();
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
      <motion.div
        initial={{ y: 0 }}
        animate={{ y: isChatRouteWithSelectedChat ? 100 : 0 }}
        transition={{ duration: 0.5 }}
        className="fixed bottom-0 left-0 right-0 bg-primary text-white p-2 flex justify-around items-center shadow-lg z-20"
      >
        <NavLink to="/feed" className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}>
          <FaHome className="text-xl" />
          <span className="text-xs">Feed</span>
        </NavLink>
        <NavLink to="/jobs" className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}>
          <FaBriefcase className="text-xl" />
          <span className="text-xs">Jobs</span>
        </NavLink>
        <NavLink to="/chat" onClick={handleChatNavigation} className={({ isActive }) => `flex flex-col items-center p-2 rounded relative ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}>
          <FaComments className="text-xl" />
          {chatNotifications > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
              {chatNotifications}
            </span>
          )}
          <span className="text-xs">Chat</span>
        </NavLink>
        <NavLink to="/profile" className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}>
          <FaUser className="text-xl" />
          <span className="text-xs">Profile</span>
        </NavLink>
      </motion.div>
    </div>
  );
};

export default App;