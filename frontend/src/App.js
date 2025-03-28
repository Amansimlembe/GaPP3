import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Switch, Link, Redirect } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaHome, FaBriefcase, FaComments, FaUser, FaMoon, FaSun } from 'react-icons/fa';
import axios from 'axios';
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';
import CountrySelector from './components/CountrySelector'; // Updated import path
import io from 'socket.io-client';

const socket = io('https://gapp-6yc3.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
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
    return decoded.exp * 1000;
  } catch (error) {
    console.error('Error decoding token:', error);
    return null;
  }
};

const App = () => {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [userId, setUserId] = useState(localStorage.getItem('userId') || '');
  const [role, setRole] = useState(Number(localStorage.getItem('role')) || 0); // Ensure number
  const [photo, setPhoto] = useState(localStorage.getItem('photo') || '');
  const [virtualNumber, setVirtualNumber] = useState(localStorage.getItem('virtualNumber') || '');
  const [username, setUsername] = useState(localStorage.getItem('username') || '');
  const [chatNotifications, setChatNotifications] = useState(0);
  const [feedKey, setFeedKey] = useState(0);
  const [isAuthenticated, setIsAuthenticated] = useState(
    !!localStorage.getItem('token') && !!localStorage.getItem('userId')
  );
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');

  const refreshToken = async () => {
    try {
      const response = await axios.post(
        '/auth/refresh', // Updated to relative path
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { token: newToken, userId: newUserId, role: newRole, photo: newPhoto, virtualNumber: newVirtualNumber, username: newUsername } = response.data;
      setAuth(newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername);
      return newToken;
    } catch (error) {
      console.error('Token refresh failed:', error);
      setAuth('', '', '', '', '', '');
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
      const oneDay = 24 * 60 * 60 * 1000;

      if (expTime && expTime - now < oneDay) {
        await refreshToken();
      }
    };

    checkTokenExpiration();
    const interval = setInterval(checkTokenExpiration, 60 * 60 * 1000); // Check hourly
    return () => clearInterval(interval);
  }, [token, userId]);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    console.log('Current auth state:', { token, userId, role, photo, virtualNumber, username });
    localStorage.setItem('token', token);
    localStorage.setItem('userId', userId);
    localStorage.setItem('role', role);
    localStorage.setItem('photo', photo);
    localStorage.setItem('virtualNumber', virtualNumber);
    localStorage.setItem('username', username);

    if (userId && token) {
      socket.emit('join', userId);
      socket.on('message', (msg) => {
        if (msg.recipientId === userId) {
          setChatNotifications((prev) => prev + 1);
        }
      });
      setIsAuthenticated(true);
    } else {
      console.error('Missing userId or token for socket join:', { userId, token });
      setIsAuthenticated(false);
    }

    return () => socket.off('message');
  }, [token, userId, role, photo, virtualNumber, username]);

  const setAuth = (newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername) => {
    console.log('Setting auth:', { newToken, newUserId, newRole, newPhoto, newVirtualNumber, newUsername });
    setToken(newToken || '');
    setUserId(newUserId || '');
    setRole(Number(newRole) || 0); // Ensure number
    setPhoto(newPhoto || '');
    setVirtualNumber(newVirtualNumber || '');
    setUsername(newUsername || '');
    localStorage.setItem('token', newToken || '');
    localStorage.setItem('userId', newUserId || '');
    localStorage.setItem('role', String(newRole || 0)); // Store as string but convert on read
    localStorage.setItem('photo', newPhoto || '');
    localStorage.setItem('virtualNumber', newVirtualNumber || '');
    localStorage.setItem('username', newUsername || '');
    setIsAuthenticated(!!newToken && !!newUserId);
  };
  const toggleTheme = () => {
    setTheme((prevTheme) => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  const handleChatNavigation = () => {
    setChatNotifications(0);
  };

  if (!isAuthenticated) {
    console.log('Redirecting to login due to missing token or userId');
    return <LoginScreen setAuth={setAuth} />;
  }

  return (
    <Router>
      <div className={`min-h-screen flex flex-col ${theme}`}>
        {!virtualNumber && (
          <CountrySelector
            token={token}
            userId={userId}
            virtualNumber={virtualNumber}
            onComplete={(newVirtualNumber) => setAuth(token, userId, role, photo, newVirtualNumber, username)}
          />
        )}
        <div className="flex-1 container p-0 relative">
          <Switch>
            <Route
              path="/jobs"
              render={() =>
                parseInt(role) === 0 ? (
                  <JobSeekerScreen token={token} userId={userId} />
                ) : (
                  <EmployerScreen token={token} userId={userId} />
                )
              }
            />
            <Route path="/feed" render={() => <FeedScreen token={token} userId={userId} key={feedKey} />} />
            <Route
              path="/chat"
              render={() => <ChatScreen token={token} userId={userId} onNavigate={handleChatNavigation} setAuth={setAuth} />}
            />
            <Route
              path="/profile"
              render={() => (
                <ProfileScreen
                  token={token}
                  userId={userId}
                  setAuth={setAuth}
                  username={username}
                  virtualNumber={virtualNumber}
                  photo={photo}
                />
              )}
            />
            <Route path="/" exact>
              <Redirect to="/feed" />
            </Route>
          </Switch>
        </div>
        <motion.div
          initial={{ y: 100 }}
          animate={{ y: 0 }}
          transition={{ duration: 0.5 }}
          className="fixed bottom-0 left-0 right-0 bg-primary text-white p-2 flex justify-around items-center shadow-lg z-20 bottom-nav"
        >
          <Link
            to="/feed"
            onClick={() => setFeedKey(feedKey + 1)}
            className="flex flex-col items-center p-2 hover:bg-secondary rounded"
          >
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