import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Switch, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaSignOutAlt, FaBars } from 'react-icons/fa';
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';

const App = () => {
  const [userId, setUserId] = useState(null);
  const [role, setRole] = useState(null);
  const [photo, setPhoto] = useState('');
  const [isNavOpen, setIsNavOpen] = useState(false);

  useEffect(() => {
    const user = localStorage.getItem('user');
    if (user) {
      const { userId, role, photo } = JSON.parse(user);
      setUserId(userId);
      setRole(role);
      setPhoto(photo || '');
    }
  }, []);

  const logout = () => {
    localStorage.removeItem('user');
    setUserId(null);
    setRole(null);
    setPhoto('');
  };

  if (!userId) return <LoginScreen setUser={(id, r, p) => { setUserId(id); setRole(r); setPhoto(p); }} />;

  return (
    <Router>
      <div className="min-h-screen flex flex-col">
        {/* Top Navigation for Small Devices */}
        <div className="md:hidden bg-primary text-white p-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold">GaPP</h1>
          <FaBars className="text-2xl cursor-pointer" onClick={() => setIsNavOpen(!isNavOpen)} />
        </div>
        <motion.div
          initial={{ height: 0 }}
          animate={{ height: isNavOpen ? 'auto' : 0 }}
          className="md:hidden bg-primary text-white overflow-hidden"
        >
          <nav className="flex flex-col p-4">
            <Link to="/jobs" className="py-2 hover:bg-secondary rounded" onClick={() => setIsNavOpen(false)}>Jobs</Link>
            <Link to="/feed" className="py-2 hover:bg-secondary rounded" onClick={() => setIsNavOpen(false)}>Feed</Link>
            <Link to="/chat" className="py-2 hover:bg-secondary rounded" onClick={() => setIsNavOpen(false)}>Chat</Link>
            <Link to="/profile" className="py-2 hover:bg-secondary rounded" onClick={() => setIsNavOpen(false)}>Profile</Link>
          </nav>
        </motion.div>

        {/* Sidebar for Larger Devices */}
        <motion.div
          initial={{ x: -250 }}
          animate={{ x: 0 }}
          className="hidden md:block w-64 bg-primary text-white p-4 h-screen fixed"
        >
          <h1 className="text-2xl font-bold mb-6">GaPP</h1>
          <nav>
            <Link to="/jobs" className="block py-2 px-4 hover:bg-secondary rounded">Jobs</Link>
            <Link to="/feed" className="block py-2 px-4 hover:bg-secondary rounded">Feed</Link>
            <Link to="/chat" className="block py-2 px-4 hover:bg-secondary rounded">Chat</Link>
            <Link to="/profile" className="block py-2 px-4 hover:bg-secondary rounded">Profile</Link>
          </nav>
        </motion.div>

        {/* Main Content */}
        <div className="flex-1 md:ml-64 container relative">
          <div className="absolute top-4 right-4 flex items-center">
            {photo && <img src={`https://gapp-6yc3.onrender.com${photo}`} alt="Profile" className="w-10 h-10 rounded-full mr-2" />}
            <FaSignOutAlt className="text-2xl text-primary cursor-pointer hover:text-secondary transition duration-300" onClick={logout} />
          </div>
          <Switch>
            <Route path="/jobs" component={role === 0 ? JobSeekerScreen : EmployerScreen} />
            <Route path="/feed" component={FeedScreen} />
            <Route path="/chat" component={ChatScreen} />
            <Route path="/profile" component={ProfileScreen} />
            <Route path="/" component={role === 0 ? JobSeekerScreen : EmployerScreen} exact />
          </Switch>
        </div>
      </div>
    </Router>
  );
};

export default App;