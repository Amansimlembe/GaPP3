import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { getCountries } from 'libphonenumber-js';
import { FaEye, FaEyeSlash } from 'react-icons/fa';

const LoginScreen = ({ setAuth }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isCountryInputFocused, setIsCountryInputFocused] = useState(false);
  const [showLocationConfirm, setShowLocationConfirm] = useState(false);
  const countryInputRef = useRef(null);

  let countries = [];
  try {
    countries = getCountries().map((code) => ({
      code,
      name: new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code,
    }));
  } catch (err) {
    console.error('Error loading countries:', err);
    setError('Failed to load countries, please try again');
  }

  const filteredCountries = countries.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.code.toLowerCase().includes(search.toLowerCase())
  );

  const validateForm = () => {
    // Email: Must be valid
    if (!email || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
      setError('Please enter a valid email');
      return false;
    }
    // Password: 8+ chars, 1 lowercase, 1 uppercase, 1 number, 1 special char
    if (
      !password ||
      !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(password)
    ) {
      setError(
        'Password must be at least 8 characters with one lowercase, one uppercase, one number, and one special character'
      );
      return false;
    }
    if (!isLogin) {
      // Username: 3–20 chars
      if (!username || username.length < 3 || username.length > 20) {
        setError('Username must be between 3 and 20 characters');
        return false;
      }
      // Country: 2-letter ISO code
      if (!selectedCountry || !countries.find((c) => c.code === selectedCountry)) {
        setError('Please select a valid country');
        return false;
      }
      // Confirm password
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return false;
      }
    }
    return true;
  };

  const checkLocation = async (selectedCountry) => {
    if (isLogin) return true;
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          resolve,
          (err) => reject(err),
          { timeout: 10000, maximumAge: 60000, enableHighAccuracy: false }
        );
      });
      const { latitude, longitude } = position.coords;
      const response = await axios.get(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`,
        { timeout: 5000 }
      );
      const currentCountryCode = response.data.countryCode;
      if (currentCountryCode !== selectedCountry) {
        setError(`Selected country (${selectedCountry}) does not match your current location (${currentCountryCode}).`);
        setShowLocationConfirm(true);
        return false;
      }
      return true;
    } catch (err) {
      console.warn('Geolocation error:', err.message);
      setError(
        'Unable to detect location. Ensure location services are enabled or confirm your country manually.'
      );
      setShowLocationConfirm(true);
      return false;
    }
  };

 
 

  const retryRequest = async (data, config, retries = 3, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.post(
        `https://gapp-6yc3.onrender.com/auth/${isLogin ? 'login' : 'register'}`,
        data,
        config
      );
      return response.data;
    } catch (err) {
      console.error(`Attempt ${i + 1} failed:`, {
        status: err.response?.status,
        data: JSON.stringify(err.response?.data || {}),
        message: err.message,
        requestData: isLogin ? JSON.stringify(data) : JSON.stringify({ ...data, password: '[REDACTED]' }),
      });
      if (
        isLogin &&
        err.response?.status === 401 &&
        (err.response?.data?.error === 'Email not registered' ||
          err.response?.data?.error === 'Wrong password')
      ) {
        throw err;
      }
      if ((err.response?.status === 429 || err.response?.status >= 500) && i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
        continue;
      }
      throw err;
    }
  }
};

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setShowLocationConfirm(false);
    if (!validateForm()) return;

    if (!isLogin) {
      const locationValid = await checkLocation(selectedCountry);
      if (!locationValid && !showLocationConfirm) return;
    }

    setLoading(true);
    try {
      const data = isLogin
        ? { email, password }
        : { email, password, username, country: selectedCountry };
      const config = { headers: { 'Content-Type': 'application/json' } };
      const response = await retryRequest(data, config);

      if (!response.token || !response.userId) {
        throw new Error('Invalid response: Missing token or userId');
      }

      setAuth(
        response.token,
        response.userId,
        response.role,
        response.photo || 'https://placehold.co/40x40',
        response.virtualNumber || '',
        response.username || ''
      );
    } catch (error) {
      console.error(`${isLogin ? 'Login' : 'Register'} error:`, {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        details: JSON.stringify(error.response?.data?.details || {}),
      });
      const errorMessage =
        error.response?.status === 429
          ? 'Too many requests. Please wait a few minutes and try again.'
          : error.response?.data?.error ||
            error.message ||
            (isLogin ? 'Login failed' : 'Registration failed');
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleLocationConfirm = async () => {
    setShowLocationConfirm(false);
    setError('');
    await handleSubmit({ preventDefault: () => {} });
  };

  const resetInputs = () => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setUsername('');
    setSelectedCountry('');
    setSearch('');
    setError('');
    setShowPassword(false);
    setShowConfirmPassword(false);
    setIsCountryInputFocused(false);
    setShowLocationConfirm(false);
  };

  const handleCountrySelect = (country) => {
    setSelectedCountry(country.code);
    setSearch(country.name);
    setIsCountryInputFocused(false);
  };

  const handleCountryKeyDown = (e) => {
    if (e.key === 'Enter' && filteredCountries.length > 0) {
      e.preventDefault();
      handleCountrySelect(filteredCountries[0]);
    }
  };

  const handleCountryChange = (e) => {
    setSearch(e.target.value);
    setSelectedCountry(''); // Reset until a country is selected
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (countryInputRef.current && !countryInputRef.current.contains(e.target)) {
        if (filteredCountries.length > 0 && search && !selectedCountry) {
          handleCountrySelect(filteredCountries[0]);
        }
        setIsCountryInputFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [filteredCountries, search, selectedCountry]);

  const getCountryInputValue = () => {
    return search;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -50 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900"
    >
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md">
        <h2 className="text-2xl font-bold mb-4 text-blue-600 dark:text-white">
          {isLogin ? 'Login' : 'Register'}
        </h2>
        {error && (
          <p className="text-white bg-blue-600 mb-4 text-center p-2 rounded">
            {error}
            <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
          </p>
        )}
        {showLocationConfirm && (
          <div className="mb-4 p-4 bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 rounded-lg">
            <p className="mb-2">
              Unable to verify your location. Are you sure you are in{' '}
              {countries.find((c) => c.code === selectedCountry)?.name}?
            </p>
            <div className="flex justify-between">
              <button
                onClick={handleLocationConfirm}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
                disabled={loading}
              >
                Confirm
              </button>
              <button
                onClick={() => setShowLocationConfirm(false)}
                className="bg-gray-300 dark:bg-gray-600 text-gray-800 dark:text-white px-4 py-2 rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500"
                disabled={loading}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
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
              <div className="relative" ref={countryInputRef}>
                <input
                  type="text"
                  value={getCountryInputValue()}
                  onChange={handleCountryChange}
                  onFocus={() => setIsCountryInputFocused(true)}
                  onKeyDown={handleCountryKeyDown}
                  className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                  placeholder="Select a country"
                  disabled={loading}
                />
                {isCountryInputFocused && (
                  <div className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                    <ul>
                      {filteredCountries.length > 0 ? (
                        filteredCountries.map((c, index) => (
                          <li
                            key={c.code}
                            onClick={() => handleCountrySelect(c)}
                            className={`p-2 cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 ${
                              index === 0 ? 'bg-gray-100 dark:bg-gray-600' : ''
                            }`}
                          >
                            {c.name}
                          </li>
                        ))
                      ) : (
                        <li className="p-2 text-gray-500 dark:text-gray-400">No countries found</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            </>
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
            placeholder="Email"
            required
            disabled={loading}
          />
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
              placeholder="Password (8+ chars, mixed case, number, special)"
              required
              disabled={loading}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-500 dark:text-gray-300"
              disabled={loading}
            >
              {showPassword ? <FaEyeSlash size={20} /> : <FaEye size={20} />}
              
              
            </button>
          </div>
          {!isLogin && (
            <div className="relative">
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                placeholder="Confirm Password"
                required
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-500 dark:text-gray-300"
                disabled={loading}
              >
                {showConfirmPassword ? <FaEyeSlash size={20} /> : <FaEye size={20} />}
              </button>
            </div>
          )}
          <button
            type="submit"
            className={`w-full bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-700 ${
              loading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
            disabled={loading}
          >
            {loading ? 'Processing...' : isLogin ? 'Login' : 'Register'}
          </button>
        </form>
        <p className="mt-4 text-center text-gray-600 dark:text-gray-300">
          {isLogin ? "Don't have an account?" : 'Already have an account?'}{' '}
          <span
            onClick={() => {
              if (!loading) {
                setIsLogin(!isLogin);
                resetInputs();
              }
            }}
            className={`text-blue-600 cursor-pointer hover:underline ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isLogin ? 'Register' : 'Login'}
          </span>
        </p>
      </div>
    </motion.div>
  );
};

export default LoginScreen;