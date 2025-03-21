import React, { useState } from 'react';
import { BrowserRouter as Router, Route, Switch, Link, Redirect } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaSignOutAlt, FaBars } from 'react-icons/fa';
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';

const App = () => {
  const [token, setToken] = useState(null);
  const [userId, setUserId] = useState(null);
  const [role, setRole] = useState(null);
  const [photo, setPhoto] = useState('');

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
  };

  if (!token || !userId) return <LoginScreen setAuth={setAuth} />;

  return (
    <Router>
      <div className="min-h-screen flex flex-col">
        {/* Mobile Nav */}
        <div className="md:hidden bg-primary text-white p-4 flex justify-between items-center shadow-lg">
          <h1 className="text-2xl font-bold">GaPP</h1>
          <FaBars className="text-2xl cursor-pointer hover:text-secondary transition duration-300" onClick={() => setIsNavOpen(!isNavOpen)} />
        </div>
        {/* Sidebar */}
        <motion.div
          initial={{ x: -250 }}
          animate={{ x: 0 }}
          transition={{ duration: 0.5 }}
          className="hidden md:block w-64 bg-primary text-white p-4 h-screen fixed shadow-lg"
        >
          <h1 className="text-2xl font-bold mb-6">GaPP</h1>
          <nav>
            <Link to="/jobs" className="block py-2 px-4 hover:bg-secondary rounded transition duration-300">Jobs</Link>
            <Link to="/feed" className="block py-2 px-4 hover:bg-secondary rounded transition duration-300">Feed</Link>
            <Link to="/chat" className="block py-2 px-4 hover:bg-secondary rounded transition duration-300">Chat</Link>
            <Link to="/profile" className="block py-2 px-4 hover:bg-secondary rounded transition duration-300">Profile</Link>
          </nav>
        </motion.div>

        <div className="flex-1 md:ml-64 container relative">
          <div className="absolute top-4 right-4 flex items-center">
            {photo && <img src={photo} alt="Profile" className="w-10 h-10 rounded-full mr-2 border-2 border-primary" />}
            <FaSignOutAlt className="text-2xl text-primary cursor-pointer hover:text-secondary transition duration-300" onClick={logout} />
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
      </div>
    </Router>
  );
};

export default App;