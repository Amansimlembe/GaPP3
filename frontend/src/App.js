import React, { useState, useEffect } from 'react';
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
import { setAuth, clearAuthData, setSelectedChat } from './store';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    axios.post(`${BASE_URL}/social/log-error`, {
      error: error.message,
      stack: errorInfo.componentStack?.toString() || 'No stack trace',
      userId: this.props.userId || 'unknown',
      route: window.location.pathname,
      timestamp: new Date().toISOString(),
    }).catch((err) => console.warn('Failed to log error:', err.message));
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-screen p-4 text-center bg-gray-100 dark:bg-gray-900 min-h-screen h-full">
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">Something went wrong</h2>
          <p className="my-2 text-gray-600 dark:text-gray-400">{this.state.error?.message || 'Unknown error'}</p>
          <div className="flex gap-4 justify-center">
            <button
              className="bg-primary text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition-colors"
              onClick={() => window.location.reload(true)}
            >
              Refresh
            </button>
            {this.props.onLogout && (
              <button
                className="bg-red-500 text-white px-4 py-2 rounded-lg hover:bg-red-600 transition-colors"
                onClick={() => this.props.onLogout()}
              >
                Log Out
              </button>
            )}
          </div>
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
  const dispatch = useDispatch();
  const { token, userId, role, photo, virtualNumber, username, privateKey } = useSelector((state) => state.auth);
  const { selectedChat } = useSelector((state) => state.messages);
  const [chatNotifications, setChatNotifications] = useState(0);
  const [isAuthenticated, setIsAuthenticated] = useState(!!token && !!userId);
  const [socket, setSocket] = useState(null);
  const [theme, setTheme] = useState(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) return savedTheme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [error, setError] = useState(null);

  const setAuthData = (newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername, newPrivateKey) => {
    if (newToken && newUserId) {
      dispatch(setAuth({
        token: newToken,
        userId: newUserId,
        role: Number(newRole),
        photo: newPhoto || 'https://placehold.co/40x40',
        virtualNumber: newVirtualNumber || '',
        username: newUsername || '',
        privateKey: newPrivateKey || '',
      }));
      localStorage.setItem('token', newToken);
      localStorage.setItem('userId', newUserId);
      localStorage.setItem('role', String(newRole));
      localStorage.setItem('photo', newPhoto || 'https://placehold.co/40x40');
      localStorage.setItem('virtualNumber', newVirtualNumber || '');
      localStorage.setItem('username', newUsername || '');
      localStorage.setItem('privateKey', newPrivateKey || '');
      setIsAuthenticated(true);
      setError(null);
    } else {
      handleLogout();
    }
  };

  const handleLogout = () => {
    if (socket) {
      socket.emit('leave', userId);
      socket.disconnect();
    }
    dispatch(clearAuthData());
    localStorage.clear();
    sessionStorage.clear();
    setIsAuthenticated(false);
    setSocket(null);
    setChatNotifications(0);
    setError(null);
    setAuthData(null, null, null, null, null, null, null);
    console.log('Logged out, state cleared');
  };

  useEffect(() => {
    // Global axios interceptor for 401 errors
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401) {
          console.warn('401 Unauthorized, attempting token refresh');
          const newToken = await refreshToken();
          if (newToken) {
            error.config.headers.Authorization = `Bearer ${newToken}`;
            return axios(error.config);
          } else {
            handleLogout();
            setError('Session expired, please log in again');
          }
        }
        return Promise.reject(error);
      }
    );

    return () => {
      axios.interceptors.response.eject(interceptor);
    };
  }, [token, userId]);

  useEffect(() => {
    if (!token || !userId) {
      console.warn('Missing token or userId, logging out');
      handleLogout();
      return;
    }

    const newSocket = io(BASE_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
      timeout: 10000,
    });
    setSocket(newSocket);

    return () => {
      newSocket.emit('leave', userId);
      newSocket.disconnect();
      console.log('Socket cleaned up');
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
          timeout: 10000,
        }
      );
      const { token: newToken, userId: newUserId, role: newRole, photo: newPhoto, virtualNumber: newVirtualNumber, username: newUsername, privateKey: newPrivateKey } = response.data;
      setAuthData(newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername, newPrivateKey);
      console.log('Token refreshed successfully');
      return newToken;
    } catch (error) {
      console.error('Token refresh failed:', error.response?.data?.error || error.message);
      handleLogout();
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
        if (!expTime) {
          console.warn('Invalid token expiration, logging out');
          handleLogout();
          return;
        }
        if (expTime - Date.now() < 10 * 60 * 1000) { // 10 minutes before expiry
          await refreshToken();
        }
      } catch (err) {
        console.error('Token expiration check failed:', err.message);
        handleLogout();
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
      if (error.message.includes('Invalid token') || error.message.includes('No token provided') || error.message.includes('Token invalidated')) {
        const newToken = await refreshToken();
        if (newToken) {
          socket.auth.token = newToken;
          socket.disconnect().connect();
        } else {
          handleLogout();
        }
      }
    });

    socket.on('error', (data) => {
      console.error('Socket error:', data.message);
      setError(data.message || 'Socket error occurred');
      if (data.message.includes('Invalid token') || data.message.includes('Unauthorized')) {
        handleLogout();
      }
    });

    socket.on('disconnect', (reason) => {
      console.warn('Socket disconnected:', reason);
      if (reason === 'io server disconnect') {
        socket.connect();
      }
    });

    socket.on('message', (msg) => {
      console.log('Received message:', msg);
      if (msg.recipientId === userId && (!selectedChat || selectedChat !== msg.senderId)) {
        setChatNotifications((prev) => prev + 1);
      }
    });

    socket.on('contactData', (data) => {
      console.log('New contact data:', data);
      setChatNotifications((prev) => prev + 1); // Notify for new contacts
    });

    socket.on('userStatus', (data) => {
      console.log('User status update:', data);
      // Optionally update UI for contact status
    });

    socket.on('userDeleted', (data) => {
      console.log('User deleted:', data);
      if (selectedChat === data.userId) {
        dispatch(setSelectedChat(null));
      }
      setChatNotifications(0); // Reset notifications
    });

    return () => {
      socket.off('connect');
      socket.off('connect_error');
      socket.off('error');
      socket.off('disconnect');
      socket.off('message');
      socket.off('contactData');
      socket.off('userStatus');
      socket.off('userDeleted');
    };
  }, [socket, userId, selectedChat, dispatch]);

  useEffect(() => {
    document.documentElement.className = theme;
    localStorage.setItem('theme', theme);
    // Sync with system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      if (!localStorage.getItem('theme')) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
  };

  const handleChatNavigation = () => {
    console.log('Navigating to ChatScreen');
    setChatNotifications(0);
    dispatch(setSelectedChat(null));
  };

  if (!isAuthenticated) {
    return (
      <ErrorBoundary>
        {error && (
          <div className="fixed top-0 left-0 right-0 bg-red-500 text-white p-2 text-center z-50">
            {error}
            <button
              className="ml-4 bg-white text-red-500 px-2 py-1 rounded text-sm"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        <LoginScreen setAuth={setAuthData} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary userId={userId} onLogout={handleLogout}>
      {error && (
        <div className="fixed top-0 left-0 right-0 bg-red-500 text-white p-2 text-center z-50">
          {error}
          <button
            className="ml-4 bg-white text-red-500 px-2 py-1 rounded text-sm"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
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
          privateKey={privateKey}
          chatNotifications={chatNotifications}
          setAuth={setAuthData}
          socket={socket}
          toggleTheme={toggleTheme}
          handleChatNavigation={handleChatNavigation}
          theme={theme}
          handleLogout={handleLogout}
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
  privateKey,
  chatNotifications,
  setAuth,
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
    console.log('Current route:', location.pathname, 'Selected chat:', selectedChat);
  }, [location.pathname, selectedChat]);

  return (
    <div className={`min-h-screen flex flex-col ${theme} bg-gray-100 dark:bg-gray-900`}>
      {!virtualNumber && (
        <CountrySelector
          token={token}
          userId={userId}
          virtualNumber={virtualNumber}
          onComplete={(newVirtualNumber) => setAuth(token, userId, role, photo, newVirtualNumber, username, privateKey)}
        />
      )}
      <div className="flex-1 p-0 relative">
        <Routes>
          <Route
            path="/jobs"
            element={
              role === 0 ? (
                <JobSeekerScreen token={token} userId={userId} onUnauthorized={handleLogout} />
              ) : (
                <EmployerScreen token={token} userId={userId} onUnauthorized={handleLogout} />
              )
            }
          />
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
                setAuth={setAuth}
                socket={socket}
                username={username}
                virtualNumber={virtualNumber}
                photo={photo}
                privateKey={privateKey}
                onUnauthorized={handleLogout}
              />
            }
          />
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
                privateKey={privateKey}
                onUnauthorized={handleLogout}
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
          className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}
        >
          <FaHome className="text-xl" />
          <span className="text-xs">Feed</span>
        </NavLink>
        <NavLink
          to="/jobs"
          className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}
        >
          <FaBriefcase className="text-xl" />
          <span className="text-xs">Jobs</span>
        </NavLink>
        <NavLink
          to="/chat"
          onClick={handleChatNavigation}
          className={({ isActive }) => `flex flex-col items-center p-2 rounded relative ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}
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
          className={({ isActive }) => `flex flex-col items-center p-2 rounded ${isActive ? 'bg-secondary' : 'hover:bg-secondary'}`}
        >
          <FaUser className="text-xl" />
          <span className="text-xs">Profile</span>
        </NavLink>
      </motion.nav>
    </div>
  );
};

export default App;