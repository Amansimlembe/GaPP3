import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Switch } from 'react-router-dom';
import LoginScreen from './screens/LoginScreen';  // Correct path
import JobSeekerScreen from './screens/JobSeekerScreen';
import EmployerScreen from './screens/EmployerScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import ProfileScreen from './screens/ProfileScreen';

// Rest of the code remains the same

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