import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Switch, Link, Redirect } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { FaHome, FaBriefcase, FaComments, FaUser } from 'react-icons/fa'; // Correct import
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';
import CountrySelector from './components/CountrySelector';
import io from 'socket.io-client';

const socket = io('https://gapp-6yc3.onrender.com');

const App = () => {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [userId, setUserId] = useState(localStorage.getItem('userId') || '');
  const [role, setRole] = useState(localStorage.getItem('role') || '');
  const [photo, setPhoto] = useState(localStorage.getItem('photo') || '');
  const [virtualNumber, setVirtualNumber] = useState(localStorage.getItem('virtualNumber') || '');
  const [chatNotifications, setChatNotifications] = useState(0);
  const [feedKey, setFeedKey] = useState(0);

  useEffect(() => {
    localStorage.setItem('token', token);
    localStorage.setItem('userId', userId);
    localStorage.setItem('role', role);
    localStorage.setItem('photo', photo);
    localStorage.setItem('virtualNumber', virtualNumber);

    if (userId) {
      socket.emit('join', userId);
      socket.on('message', (msg) => {
        if (msg.recipientId === userId) {
          setChatNotifications((prev) => prev + 1);
        }
      });
    }

    return () => socket.off('message');
  }, [token, userId, role, photo, virtualNumber]);

  const setAuth = (newToken, newUserId, newRole, newPhoto, newVirtualNumber) => {
    setToken(newToken);
    setUserId(newUserId);
    setRole(newRole);
    setPhoto(newPhoto || '');
    setVirtualNumber(newVirtualNumber || '');
  };

  if (!token || !userId) return <LoginScreen setAuth={setAuth} />;

  return (
    <Router>
      <div className="min-h-screen flex flex-col">
        {!virtualNumber && <CountrySelector token={token} userId={userId} onComplete={(vn) => setAuth(token, userId, role, photo, vn)} />}
        <div className="flex-1 container p-0 relative">
          <Switch>
            <Route path="/jobs" render={() => (parseInt(role) === 0 ? <JobSeekerScreen token={token} userId={userId} /> : <EmployerScreen token={token} userId={userId} />)} />
            <Route path="/feed" render={() => <FeedScreen token={token} userId={userId} key={feedKey} />} />
            <Route path="/chat" render={() => <ChatScreen token={token} userId={userId} />} />
            <Route path="/profile" render={() => <ProfileScreen token={token} userId={userId} setAuth={setAuth} />} />
            <Route path="/" exact>
              <Redirect to="/feed" />
            </Route>
          </Switch>
        </div>
        <motion.div
          initial={{ y: 100 }}
          animate={{ y: 0 }}
          transition={{ duration: 0.5 }}
          className="fixed bottom-0 left-0 right-0 bg-primary text-white p-2 flex justify-around items-center shadow-lg z-20"
        >
          <Link to="/feed" onClick={() => setFeedKey(feedKey + 1)} className="flex flex-col items-center p-2 hover:bg-secondary rounded">
            <FaHome className="text-xl" />
            <span className="text-xs">Feed</span>
          </Link>
          <Link to="/jobs" className="flex flex-col items-center p-2 hover:bg-secondary rounded">
            <FaBriefcase className="text-xl" />
            <span className="text-xs">Jobs</span>
          </Link>
          <Link to="/chat" className="flex flex-col items-center p-2 hover:bg-secondary rounded relative">
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
        </motion.div>
      </div>
    </Router>
  );
};

export default App;