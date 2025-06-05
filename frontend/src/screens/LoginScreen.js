import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { motion } from 'framer-motion';
import { getCountries } from 'libphonenumber-js';
import { FaEye, FaEyeSlash } from 'react-icons/fa';
import { setAuth } from '../store';

const LoginScreen = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
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
  const [bypassLocation, setBypassLocation] = useState(false);
  const countryInputRef = useRef(null);

  // Initialize countries using useMemo to avoid re-computation
  const countries = useMemo(() => {
    try {
      return getCountries().map((code) => ({
        code,
        name: new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code,
      }));
    } catch (err) {
      console.error('Error loading countries:', err);
      setError('Failed to load countries, please try again');
      return [];
    }
  }, []);

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
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return false;
      }
    }
    return true;
  };

  const checkLocation = async (selectedCountry) => {
    if (isLogin || bypassLocation) return true; // Skip for login or if bypassing
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 10000, // 10-second timeout
          maximumAge: 60000, // Accept cached position up to 1 minute old
          enableHighAccuracy: true,
        });
      });
      const { latitude, longitude } = position.coords;
      const response = await axios.get(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`,
        { timeout: 5000 }
      );
      const currentCountryCode = response.data.countryCode;
      if (currentCountryCode !== selectedCountry) {
        setError('Selected country does not match your current location.');
        return false;
      }
      return true;
    } catch (err) {
      console.error('Location check failed:', err);
      if (err.code === 1) { // PERMISSION_DENIED
        setError('Location access denied. Please enable location services and try again.');
      } else if (err.code === 2 || err.code === 3) { // POSITION_UNAVAILABLE or TIMEOUT
        setError('Unable to detect location. Please check your network or location settings.');
      } else {
        setError('Failed to verify location. Try again or bypass location check for testing.');
      }
      return false;
    }
  };

  const retryRequest = async (data, config, retries = 3, delay = 1000) => {
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
          data: err.response?.data,
          message: err.message,
        });
        if (isLogin && err.response?.status === 401 && 
            (err.response?.data?.error === 'Email not registered' || 
             err.response?.data?.error === 'Wrong password')) {
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
    if (!validateForm()) return;

    if (!isLogin) {
      const locationValid = await checkLocation(selectedCountry);
      if (!locationValid) return;
    }

    setLoading(true);
    try {
      const data = isLogin
        ? { email, password }
        : (() => {
            const formData = new FormData();
            formData.append('email', email);
            formData.append('password', password);
            formData.append('username', username);
            formData.append('country', selectedCountry);
            return formData;
          })();

      const config = isLogin
        ? { headers: { 'Content-Type': 'application/json' } }
        : { headers: { 'Content-Type': 'multipart/form-data' } };

      const response = await retryRequest(data, config);

      dispatch(setAuth({
        token: response.token,
        userId: response.userId,
        role: response.role,
        photo: response.photo || 'https://placehold.co/40x40',
        virtualNumber: response.virtualNumber || '',
        username: response.username || '',
        privateKey: response.privateKey || '',
      }));

      navigate('/feed');
    } catch (error) {
      const errorMessage =
        error.response?.status === 429
          ? 'Too many requests, please try again later'
          : error.response?.data?.error ||
            error.response?.data?.details ||
            error.message ||
            (isLogin ? 'Login failed' : 'Registration failed. Please try again.');
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
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
    setBypassLocation(false);
  };

  const handleCountrySelect = (country) => {
    setSelectedCountry(country.code);
    setSearch('');
    setIsCountryInputFocused(false);
  };

  const handleCountryKeyDown = (e) => {
    if (e.key === 'Enter' && filteredCountries.length > 0) {
      e.preventDefault();
      setSelectedCountry(filteredCountries[0].code);
      setSearch('');
      setIsCountryInputFocused(false);
    }
  };

  const handleCountryChange = (e) => {
    setSearch(e.target.value);
    if (selectedCountry) {
      setSelectedCountry('');
    }
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (countryInputRef.current && !countryInputRef.current.contains(e.target)) {
        if (filteredCountries.length > 0 && search) {
          setSelectedCountry(filteredCountries[0].code);
          setSearch('');
        }
        setIsCountryInputFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [filteredCountries, search]);

  const getCountryInputValue = () => {
    if (search) return search;
    if (selectedCountry) {
      const country = countries.find((c) => c.code === selectedCountry);
      return country ? country.name : '';
    }
    return '';
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -50 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900"
    >
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md">
        <h2 className="text-2xl font-bold mb-4 text-blue-500 dark:text-white">
          {isLogin ? 'Login' : 'Register'}
        </h2>
        {error && (
          <p className="text-red-500 mb-4 text-center">
            {error}
            {error.includes('location') && (
              <button
                onClick={() => setBypassLocation(true)}
                className="ml-2 text-blue-500 underline"
              >
                Bypass for Testing
              </button>
            )}
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:ring-2 focus:ring-blue-500"
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
                  className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:ring-2 focus:ring-blue-500"
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
                            className={`p-2 cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 ${index === 0 ? 'bg-gray-100 dark:bg-gray-600' : ''}`}
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
            className="w-full p-2 border rounded-md dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:ring-2 focus:ring-blue-500"
            placeholder="Email"
            required
            disabled={loading}
          />
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-2 border rounded-md dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:ring-2 focus:ring-blue-500"
              placeholder="Password (min 6 characters)"
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
                className="w-full p-2 border rounded-md dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:ring-2 focus:ring-blue-500"
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
            className={`w-full bg-blue-500 text-white p-2 rounded-lg hover:bg-blue-600 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
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
            className={`text-blue-500 cursor-pointer hover:underline ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isLogin ? 'Register' : 'Login'}
          </span>
        </p>
      </div>
    </motion.div>
  );
};

export default LoginScreen;