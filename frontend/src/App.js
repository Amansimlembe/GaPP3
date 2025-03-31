import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaHome, FaBriefcase, FaComments, FaUser, FaMoon, FaSun } from 'react-icons/fa';
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

const socket = io('https://gapp-6yc3.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  withCredentials: true,
});

const getTokenExpiration = (token) => {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const decoded = JSON.parse(jsonPayload);
    return decoded.exp * 1000; // Convert to milliseconds
  } catch (error) {
    console.error('Error decoding token:', error);
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
  const [isAuthenticated, setIsAuthenticated] = useState(!!token && !!userId);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
  const { selectedChat } = useSelector((state) => state.messages);
  const isSmallDevice = window.innerWidth < 768;

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

    localStorage.setItem('token', token);
    localStorage.setItem('userId', userId);
    localStorage.setItem('role', String(role));
    localStorage.setItem('photo', photo);
    localStorage.setItem('virtualNumber', virtualNumber);
    localStorage.setItem('username', username);

    const authenticated = !!token && !!userId;
    setIsAuthenticated(authenticated);
    if (!authenticated) {
      socket.emit('leave', userId);
      localStorage.removeItem('privateKey');
      setChatNotifications(0);
    }
  };

  const refreshToken = async () => {
    try {
      const response = await axios.post(
        'https://gapp-6yc3.onrender.com/auth/refresh',
        {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      );
      const { token: newToken, userId: newUserId, role: newRole, photo: newPhoto, virtualNumber: newVirtualNumber, username: newUsername, privateKey } = response.data;
      setAuth(newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername);
      localStorage.setItem('privateKey', privateKey);
      console.log('Token refreshed successfully', { userId: newUserId });
      return newToken;
    } catch (error) {
      console.error('Token refresh failed:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });
      if (error.response?.status === 401) {
        setAuth('', '', '', '', '', ''); // Logout on unrecoverable 401
      }
      return null;
    }
  };

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
    if (!token || !userId) return;
  
    const checkTokenExpiration = async () => {
      const expTime = getTokenExpiration(token);
      const now = Date.now();
      const bufferTime = 5 * 60 * 1000; // Refresh 5 minutes before expiration
  
      if (expTime && expTime - now < bufferTime) {
        await refreshToken();
      }
    };
  
    checkTokenExpiration();
    const interval = setInterval(checkTokenExpiration, 60 * 1000); // Check every minute
    return () => clearInterval(interval);
  }, [token, userId]);

  
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!userId || !token) {
      setIsAuthenticated(false);
      return;
    }

    socket.emit('join', userId);

    socket.on('message', (msg) => {
      if (msg.recipientId === userId && (!selectedChat || selectedChat !== msg.senderId)) {
        setChatNotifications((prev) => prev + 1);
      }
    });

    socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
    });

    setIsAuthenticated(true);

    return () => {
      socket.off('message');
      socket.off('connect_error');
    };
  }, [userId, token, selectedChat]);

  const toggleTheme = () => {
    setTheme((prevTheme) => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  const handleChatNavigation = () => {
    setChatNotifications(0);
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900">
        <LoginScreen setAuth={setAuth} />
      </div>
    );
  }

  return (
    <Router>
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
            <Route
              path="/jobs"
              element={role === 0 ? <JobSeekerScreen token={token} userId={userId} /> : <EmployerScreen token={token} userId={userId} />}
            />
            <Route path="/feed" element={<FeedScreen token={token} userId={userId} />} />
            <Route path="/chat" element={<ChatScreen token={token} userId={userId} setAuth={setAuth} />} />
            <Route
              path="/profile"
              element={
                <ProfileScreen
                  token={token}
                  userId={userId}
                  setAuth={setAuth}
                  username={username}
                  virtualNumber={virtualNumber}
                  photo={photo}
                />
              }
            />
            <Route path="/" element={<Navigate to="/feed" replace />} />
          </Routes>
        </div>
        <motion.div
          initial={{ y: 100 }}
          animate={{ y: isSmallDevice && selectedChat ? 100 : 0 }}
          transition={{ duration: 0.5 }}
          className="fixed bottom-0 left-0 right-0 bg-primary text-white p-2 flex justify-around items-center shadow-lg z-20"
        >
          <Link to="/feed" className="flex flex-col items-center p-2 hover:bg-secondary rounded">
            <FaHome className="text-xl" />
            <span className="text-xs">Feed</span>
          </Link>
          <Link to="/jobs" className="flex flex-col items-center p-2 hover:bg-secondary rounded">
            <FaBriefcase className="text-xl" />
            <span className="text-xs">Jobs</span>
          </Link>
          <Link
            to="/chat"
            onClick={handleChatNavigation}
            className="flex flex-col items-center p-2 hover:bg-secondary rounded relative"
          >
            <FaComments className="text-xl" />
            {chatNotifications > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                {chatNotifications}
              </span>
            )}
            <span className="text-xs">Chat</span>
          </Link>
          <Link to="/profile" className="flex flex-col items-center p-2 hover:bg-secondary rounded">
            <FaUser className="text-xl" />
            <span className="text-xs">Profile</span>
          </Link>
          <div
            onClick={toggleTheme}
            className="flex flex-col items-center p-2 hover:bg-secondary rounded cursor-pointer"
          >
            {theme === 'light' ? <FaMoon className="text-xl" /> : <FaSun className="text-xl" />}
            <span className="text-xs">{theme === 'light' ? 'Dark' : 'Light'}</span>
          </div>
        </motion.div>
      </div>
    </Router>
  );
};

export default App;