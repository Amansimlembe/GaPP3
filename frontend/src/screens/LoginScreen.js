import React, { useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const LoginScreen = ({ setAuth }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('0');
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState(null);
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData();
    formData.append('email', email);
    formData.append('password', password);
    if (!isLogin) {
      formData.append('name', name);
      formData.append('role', role);
      if (photo) formData.append('photo', photo);
    }

    try {
      const url = isLogin ? '/auth/login' : '/auth/register';
      const { data } = await axios.post(url, isLogin ? { email, password } : formData, {
        headers: !isLogin ? { 'Content-Type': 'multipart/form-data' } : {},
      });
      console.log('Auth response:', data);
      setAuth(data.token, data.userId, data.role, data.photo, data.virtualNumber);
      setError('');
    } catch (error) {
      console.error('Auth error:', error);
      setError(error.response?.data?.error || 'Authentication failed');
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-6 rounded-lg shadow-lg w-full max-w-md">
        <h2 className="text-2xl font-bold mb-4 text-primary">{isLogin ? 'Login' : 'Register'}</h2>
        {error && <p className="text-red-500 mb-4">{error}</p>}
        <form onSubmit={handleSubmit}>
          {!isLogin && (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full p-2 mb-4 border rounded-lg"
              placeholder="Name"
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-2 mb-4 border rounded-lg"
            placeholder="Email"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full p-2 mb-4 border rounded-lg"
            placeholder="Password"
          />
          {!isLogin && (
            <>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full p-2 mb-4 border rounded-lg">
                <option value="0">Job Seeker</option>
                <option value="1">Employer</option>
              </select>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setPhoto(e.target.files[0])}
                className="w-full p-2 mb-4 border rounded-lg"
              />
            </>
          )}
          <button type="submit" className="w-full bg-primary text-white p-2 rounded-lg hover:bg-secondary">
            {isLogin ? 'Login' : 'Register'}
          </button>
        </form>
        <p className="mt-4 text-center">
          {isLogin ? "Don't have an account?" : 'Already have an account?'}{' '}
          <span onClick={() => setIsLogin(!isLogin)} className="text-primary cursor-pointer hover:underline">
            {isLogin ? 'Register' : 'Login'}
          </span>
        </p>
      </div>
    </motion.div>
  );
};

export default LoginScreen;