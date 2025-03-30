import React, { useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { getCountries } from 'libphonenumber-js';

const LoginScreen = ({ setAuth }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('0'); // Default to Job Seeker
  const [username, setUsername] = useState('');
  const [photo, setPhoto] = useState(null);
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const countries = getCountries().map((code) => ({
    code,
    name: new Intl.DisplayNames(['en'], { type: 'region' }).of(code),
  }));

  const filteredCountries = countries.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) || c.code.toLowerCase().includes(search.toLowerCase())
  );

  const validateForm = () => {
    if (!email || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
      setError('Please enter a valid email');
      return false;
    }
    if (!password || password.length < 6) {
      setError('Password must be at least 6 characters');
      return false;
    }
    if (!isLogin) {
      if (!username || username.length < 3 || username.length > 20) {
        setError('Username must be between 3 and 20 characters');
        return false;
      }
      if (!selectedCountry) {
        setError('Please select a country');
        return false;
      }
    }
    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!validateForm()) return;

    setLoading(true);
    const url = `https://gapp-6yc3.onrender.com/auth/${isLogin ? 'login' : 'register'}`;

    try {
      const data = isLogin
        ? { email, password }
        : (() => {
            const formData = new FormData();
            formData.append('email', email);
            formData.append('password', password);
            formData.append('username', username);
            formData.append('role', role);
            formData.append('country', selectedCountry);
            if (photo) formData.append('photo', photo);
            return formData;
          })();

      const config = !isLogin ? { headers: { 'Content-Type': 'multipart/form-data' } } : {};
      const { data: response } = await axios.post(url, data, config);

      if (!response.privateKey || !response.privateKey.includes('-----BEGIN RSA PRIVATE KEY-----')) {
        throw new Error('Received invalid private key from server');
      }

      setAuth(response.token, response.userId, response.role, response.photo, response.virtualNumber, response.username);
      localStorage.setItem('token', response.token);
      localStorage.setItem('userId', response.userId);
      localStorage.setItem('role', response.role);
      localStorage.setItem('photo', response.photo || 'https://placehold.co/40x40');
      localStorage.setItem('virtualNumber', response.virtualNumber);
      localStorage.setItem('username', response.username);
      localStorage.setItem('privateKey', response.privateKey);
    } catch (error) {
      console.error(`${isLogin ? 'Login' : 'Register'} error:`, error);
      setError(error.response?.data?.error || error.message || `${isLogin ? 'Login' : 'Registration'} failed`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -50 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900"
    >
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md">
        <h2 className="text-2xl font-bold mb-4 text-primary dark:text-white">
          {isLogin ? 'Login' : 'Register'}
        </h2>
        {error && <p className="text-red-500 mb-4 text-center">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                placeholder="Username (3-20 characters)"
                disabled={loading}
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                placeholder="Search for a country..."
                disabled={loading}
              />
              <select
                value={selectedCountry}
                onChange={(e) => setSelectedCountry(e.target.value)}
                className="w-full p-2 border rounded-lg max-h-40 overflow-y-auto dark:bg-gray-700 dark:text-white dark:border-gray-600"
                disabled={loading}
              >
                <option value="">Select a country</option>
                {filteredCountries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                disabled={loading}
              >
                <option value="0">Job Seeker</option>
                <option value="1">Employer</option>
              </select>
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif"
                onChange={(e) => setPhoto(e.target.files[0])}
                className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                disabled={loading}
              />
            </>
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
            placeholder="Email"
            disabled={loading}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
            placeholder="Password (min 6 characters)"
            disabled={loading}
          />
          <button
            type="submit"
            className={`w-full bg-primary text-white p-2 rounded-lg hover:bg-secondary ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            disabled={loading}
          >
            {loading ? 'Processing...' : isLogin ? 'Login' : 'Register'}
          </button>
        </form>
        <p className="mt-4 text-center text-gray-600 dark:text-gray-300">
          {isLogin ? "Don't have an account?" : 'Already have an account?'}{' '}
          <span
            onClick={() => !loading && setIsLogin(!isLogin)}
            className={`text-primary cursor-pointer hover:underline ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isLogin ? 'Register' : 'Login'}
          </span>
        </p>
      </div>
    </motion.div>
  );
};

export default LoginScreen;