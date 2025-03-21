import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Switch, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import LoginScreen from './screens/LoginScreen';
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';

const App = () => {
  const [userId, setUserId] = useState(null);
  const [role, setRole] = useState(null);

  useEffect(() => {
    const user = localStorage.getItem('user');
    if (user) {
      const { userId, role } = JSON.parse(user);
      setUserId(userId);
      setRole(role);
    }
  }, []);

  if (!userId) return <LoginScreen setUser={(id, r) => { setUserId(id); setRole(r); }} />;

  return (
    <Router>
      <div className="flex min-h-screen">
        {/* Sidebar Navigation */}
        <motion.div
          initial={{ x: -250 }}
          animate={{ x: 0 }}
          className="w-64 bg-primary text-white p-4"
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
        <div className="flex-1 container">
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