import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Switch } from 'react-router-dom';
import LoginScreen from './screens/LoginScreen';        // Correct import
import JobSeekerScreen from './screens/JobSeekerScreen';  // Correct import
import EmployerScreen from './screens/EmployerScreen';    // Correct import
import FeedScreen from './screens/FeedScreen';            // Correct import
import ChatScreen from './screens/ChatScreen';            // Correct import
import ProfileScreen from './screens/ProfileScreen';      // Correct import

const App = () => {
  const [userId, setUserId] = useState(null);
  const [role, setRole] = useState(null);

  useEffect(() => {
    const checkUser = async () => {
      const user = localStorage.getItem('user');
      if (user) {
        const { userId, role } = JSON.parse(user);
        setUserId(userId);
        setRole(role);
      }
    };
    checkUser();
  }, []);

  if (!userId) return <LoginScreen setUser={(id, r) => { setUserId(id); setRole(r); }} />;

  return (
    <Router>
      <Switch>
        <Route path="/jobs" component={role === 0 ? JobSeekerScreen : EmployerScreen} />
        <Route path="/feed" component={FeedScreen} />
        <Route path="/chat" component={ChatScreen} />
        <Route path="/profile" component={ProfileScreen} />
        <Route path="/" component={role === 0 ? JobSeekerScreen : EmployerScreen} exact />
      </Switch>
    </Router>
  );
};

export default App;