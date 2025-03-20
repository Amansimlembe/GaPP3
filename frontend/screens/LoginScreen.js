import React, { useState } from 'react';
import axios from 'axios';

const LoginScreen = ({ setUser }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = async () => {
    try {
      const { data } = await axios.post('/auth/login', { email, password });
      if (data.userId) {
        localStorage.setItem('user', JSON.stringify(data));
        setUser(data.userId, data.role);
      }
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  return (
    <div>
      <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button onClick={login}>Login</button>
    </div>
  );
};

export default LoginScreen;