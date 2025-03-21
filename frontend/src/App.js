import React, { useState } from 'react';
import { BrowserRouter as Router, Route, Switch, Link, Redirect } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaSignOutAlt, FaBars } from 'react-icons/fa';
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen'; // Default import
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';

const App = () => {
  const [token, setToken] = useState(null);
  const [userId, setUserId] = useState(null);
  const [role, setRole] = useState(null);
  const [photo, setPhoto] = useState('');
  const [isNavOpen, setIsNavOpen] = useState(false);

  const logout = () => {
    setToken(null);
    setUserId(null);
    setRole(null);
    setPhoto('');
  };

  if (!token) return <LoginScreen setAuth={(t, id, r, p) => { setToken(t); setUserId(id); setRole(r); setPhoto(p); }} />;

  return (
    <Router>
      <div className="min-h-screen flex flex-col">
        <div className="md:hidden bg-primary text-white p-4 flex justify-between items-center shadow-lg">
          <h1 className="text-2xl font-bold">GaPP</h1>
          <FaBars className="text-2xl cursor-pointer hover:text-secondary transition duration-300" onClick={() => setIsNavOpen(!isNavOpen)} />
        </div>
        <motion.div
          initial={{ height: 0 }}
          animate={{ height: isNavOpen ? 'auto' : 0 }}
          transition={{ duration: 0.3 }}
          className="md:hidden bg-primary text-white overflow-hidden shadow-lg"
        >
          <nav className="flex flex-col p-4">
            <Link to="/jobs" className="py-2 px-4 hover:bg-secondary rounded transition duration-300" onClick={() => setIsNavOpen(false)}>Jobs</Link>
            <Link to="/feed" className="py-2 px-4 hover:bg-secondary rounded transition duration-300" onClick={() => setIsNavOpen(false)}>Feed</Link>
            <Link to="/chat" className="py-2 px-4 hover:bg-secondary rounded transition duration-300" onClick={() => setIsNavOpen(false)}>Chat</Link>
            <Link to="/profile" className="py-2 px-4 hover:bg-secondary rounded transition duration-300" onClick={() => setIsNavOpen(false)}>Profile</Link>
          </nav>
        </motion.div>

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
            <Route path="/jobs" render={() => (role === 0 ? <JobSeekerScreen token={token} /> : <EmployerScreen token={token} />)} />
            <Route path="/feed" render={() => <FeedScreen token={token} userId={userId} />} />
            <Route path="/chat" component={ChatScreen} />
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