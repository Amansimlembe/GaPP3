import React, { useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const LoginScreen = ({ setUser }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = async () => {
    const { data } = await axios.post('/auth/login', { email, password });
    if (data.userId) {
      localStorage.setItem('user', JSON.stringify(data));
      setUser(data.userId, data.role);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex items-center justify-center min-h-screen bg-gray-100"
    >
      <div className="bg-white p-8 rounded-lg shadow-lg w-full max-w-md">
        <h2 className="text-2xl font-bold text-primary mb-6">Login to GaPP</h2>
        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full p-3 mb-4 border rounded focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-3 mb-4 border rounded focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          onClick={login}
          className="w-full bg-primary text-white p-3 rounded hover:bg-secondary transition duration-300"
        >
          Login
        </button>
      </div>
    </motion.div>
  );
};

export default LoginScreen;