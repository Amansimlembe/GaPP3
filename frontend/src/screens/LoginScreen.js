import React, { useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const LoginScreen = ({ setAuth }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('0');
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const register = async () => {
    try {
      const { data } = await axios.post('/auth/register', { email, password, role });
      setSuccess(data.message);
      setError('');
      setTimeout(() => setIsRegistering(false), 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed');
      setSuccess('');
    }
  };

  const login = async () => {
    try {
      const { data } = await axios.post('/auth/login', { email, password });
      setAuth(data.token, data.userId, data.role, data.photo || '');
      setError('');
      setSuccess(data.message);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
      setSuccess('');
    }
  };

  const handleSubmit = () => (isRegistering ? register() : login());

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5 }}
      className="flex items-center justify-center min-h-screen bg-gray-100"
    >
      <div className="bg-white p-8 rounded-lg shadow-xl w-full max-w-md">
        <h2 className="text-3xl font-bold text-primary mb-6 text-center">
          {isRegistering ? 'Register for GaPP' : 'Login to GaPP'}
        </h2>
        {error && <p className="text-red-500 mb-4 text-center">{error}</p>}
        {success && <p className="text-green-500 mb-4 text-center">{success}</p>}
        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full p-3 mb-4 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition duration-300"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-3 mb-4 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition duration-300"
        />
        {isRegistering && (
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full p-3 mb-4 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition duration-300"
          >
            <option value="0">Job Seeker</option>
            <option value="1">Employer</option>
          </select>
        )}
        <button
          onClick={handleSubmit}
          className="w-full bg-primary text-white p-3 rounded-lg hover:bg-secondary transition duration-300 shadow-md"
        >
          {isRegistering ? 'Register' : 'Login'}
        </button>
        <button
          onClick={() => setIsRegistering(!isRegistering)}
          className="w-full mt-4 text-primary hover:text-secondary hover:underline transition duration-300"
        >
          {isRegistering ? 'Already have an account? Login' : 'Need an account? Register'}
        </button>
      </div>
    </motion.div>
  );
};

export default LoginScreen;