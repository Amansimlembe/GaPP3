import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Switch, Link, Redirect } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaSignOutAlt, FaHome, FaBriefcase, FaComments, FaUser } from 'react-icons/fa';
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';

const App = () => {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [userId, setUserId] = useState(localStorage.getItem('userId'));
  const [role, setRole] = useState(localStorage.getItem('role'));
  const [photo, setPhoto] = useState(localStorage.getItem('photo') || '');

  useEffect(() => {
    localStorage.setItem('token', token || '');
    localStorage.setItem('userId', userId || '');
    localStorage.setItem('role', role || '');
    localStorage.setItem('photo', photo || '');
  }, [token, userId, role, photo]);

  const setAuth = (newToken, newUserId, newRole, newPhoto) => {
    setToken(newToken);
    setUserId(newUserId);
    setRole(newRole);
    setPhoto(newPhoto || '');
  };

  const logout = () => {
    setToken(null);
    setUserId(null);
    setRole(null);
    setPhoto('');
    localStorage.clear();
  };

  if (!token || !userId) return <LoginScreen setAuth={setAuth} />;

  return (
    <Router>
      <div className="min-h-screen flex flex-col">
        <div className="flex-1 container p-4 relative">
          <div className="absolute top-4 right-4 flex items-center">
            {photo && <img src={photo} alt="Profile" className="w-10 h-10 rounded-full mr-2 border-2 border-primary" />}
            <FaSignOutAlt className="text-2xl text-primary cursor-pointer hover:text-secondary" onClick={logout} />
          </div>
          <Switch>
            <Route path="/jobs" render={() => (parseInt(role) === 0 ? <JobSeekerScreen token={token} userId={userId} /> : <EmployerScreen token={token} userId={userId} />)} />
            <Route path="/feed" render={() => <FeedScreen token={token} userId={userId} />} />
            <Route path="/chat" render={() => <ChatScreen token={token} userId={userId} />} />
            <Route path="/profile" render={() => <ProfileScreen token={token} userId={userId} />} />
            <Route path="/" exact>
              <Redirect to="/feed" />
            </Route>
          </Switch>
        </div>
        <motion.div
          initial={{ y: 100 }}
          animate={{ y: 0 }}
          transition={{ duration: 0.5 }}
          className="fixed bottom-0 left-0 right-0 bg-primary text-white p-2 flex justify-around items-center shadow-lg"
        >
          <Link to="/feed" className="flex flex-col items-center p-2 hover:bg-secondary rounded transition duration-300">
            <FaHome className="text-xl" />
            <span className="text-xs">Feed</span>
          </Link>
          <Link to="/jobs" className="flex flex-col items-center p-2 hover:bg-secondary rounded transition duration-300">
            <FaBriefcase className="text-xl" />
            <span className="text-xs">Jobs</span>
          </Link>
          <Link to="/chat" className="flex flex-col items-center p-2 hover:bg-secondary rounded transition duration-300">
            <FaComments className="text-xl" />
            <span className="text-xs">Chat</span>
          </Link>
          <Link to="/profile" className="flex flex-col items-center p-2 hover:bg-secondary rounded transition duration-300">
            <FaUser className="text-xl" />
            <span className="text-xs">Profile</span>
          </Link>
        </motion.div>
      </div>
    </Router>
  );
};

export default App;