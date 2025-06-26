import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { getCountries } from 'libphonenumber-js';
import { FaEye, FaEyeSlash } from 'react-icons/fa';
import { useDispatch } from 'react-redux';
import { setAuth } from '../store';
import { useNavigate } from 'react-router-dom';
import { logClientError } from '../utils/errorHandler';

const LoginScreen = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [countryLoading, setCountryLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isCountryInputFocused, setIsCountryInputFocused] = useState(false);
  const countryInputRef = useRef(null);
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const countries = useMemo(() => {
    try {
      return getCountries().map((code) => ({
        code,
        name: new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code,
      }));
    } catch (err) {
      logClientError('Error loading countries', err, { component: 'LoginScreen', action: 'loadCountries' });
      setError('Failed to load countries, please try again');
      return [];
    }
  }, []);

  const filteredCountries = useMemo(
    () =>
      countries.filter(
        (c) =>
          c.name.toLowerCase().includes(search.toLowerCase().trim()) ||
          c.code.toLowerCase().includes(search.toLowerCase().trim())
      ),
    [countries, search]
  );

  const sanitizeInput = useCallback((value) => {
    return value.replace(/[<>{}]/g, '').trim(); // Remove potential XSS characters
  }, []);

  const validateForm = useCallback(() => {
    const sanitizedEmail = sanitizeInput(email);
    const sanitizedUsername = sanitizeInput(username);

    if (!sanitizedEmail || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(sanitizedEmail)) {
      setError('Please enter a valid email');
      return false;
    }
    if (!password || password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      setError('Password must be at least 8 characters with one uppercase letter and one number');
      return false;
    }
    if (!isLogin) {
      if (!sanitizedUsername || sanitizedUsername.length < 3 || sanitizedUsername.length > 20) {
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
  }, [email, password, username, selectedCountry, confirmPassword, isLogin, sanitizeInput]);

  const checkLocation = useCallback(async (selectedCountry) => {
    if (isLogin) return true;
    setCountryLoading(true);
    try {
      const position = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 })
      );
      const { latitude, longitude } = position.coords;
      const response = await axios.get(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`,
        { timeout: 5000 }
      );
      const currentCountryCode = response.data.countryCode;
      if (currentCountryCode !== selectedCountry) {
        const error = 'Selected country does not match your current location';
        logClientError(error, null, { component: 'LoginScreen', action: 'checkLocation', selectedCountry, currentCountryCode });
        setError(error);
        return false;
      }
      return true;
    } catch (err) {
      const error = 'Unable to detect location. Please ensure you are in the selected country.';
      logClientError(error, err, { component: 'LoginScreen', action: 'checkLocation', selectedCountry });
      setError(error);
      return false;
    } finally {
      setCountryLoading(false);
    }
  }, [isLogin]);

  const retryRequest = async (data, config, retries = 3, baseDelay = 1000) => {
    for (let i = 0; i < retries; i++) {
      try {
        if (!navigator.onLine) {
          throw new Error('You are offline. Please check your internet connection.');
        }
        const response = await axios.post(
          `https://gapp-6yc3.onrender.com/auth/${isLogin ? 'login' : 'register'}`,
          data,
          { ...config, timeout: 10000 }
        );
        return response.data;
      } catch (err) {
        logClientError(`${isLogin ? 'Login' : 'Register'} attempt ${i + 1} failed`, err, {
          component: 'LoginScreen',
          action: 'retryRequest',
          status: err.response?.status,
          requestData: isLogin ? data : 'FormData (multipart)',
        });
        if (
          isLogin &&
          err.response?.status === 401 &&
          (err.response?.data?.error === 'Email not registered' ||
            err.response?.data?.error === 'Wrong password')
        ) {
          throw err;
        }
        if (
          i < retries - 1 &&
          (err.response?.status === 429 ||
            err.response?.status >= 500 ||
            err.code === 'ECONNABORTED' ||
            !navigator.onLine)
        ) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * baseDelay * (1 + Math.random() * 0.1)));
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
      const sanitizedEmail = sanitizeInput(email);
      const sanitizedUsername = sanitizeInput(username);

      const data = isLogin
        ? { email: sanitizedEmail, password }
        : (() => {
            const formData = new FormData();
            formData.append('email', sanitizedEmail);
            formData.append('password', password);
            formData.append('username', sanitizedUsername);
            formData.append('country', selectedCountry);
            formData.append('role', '0');
            return formData;
          })();

      const config = isLogin
        ? { headers: { 'Content-Type': 'application/json' } }
        : { headers: { 'Content-Type': 'multipart/form-data' } };

      const response = await retryRequest(data, config);

      await dispatch(setAuth({
        token: response.token,
        userId: response.userId,
        role: response.role,
        photo: response.photo || 'https://placehold.co/40x40',
        virtualNumber: response.virtualNumber || '',
        username: response.username,
        privateKey: response.privateKey || '',
      }));

      navigate('/feed');
    } catch (error) {
      const errorMessage =
        error.message === 'You are offline. Please check your internet connection.'
          ? 'You are offline. Please check your internet connection.'
          : error.response?.status === 429
          ? 'Too many requests, please try again later'
          : error.response?.data?.error ||
            error.response?.data?.details ||
            error.message ||
            (isLogin ? 'Login failed' : 'Registration failed. Please try again.');
      logClientError(errorMessage, error, {
        component: 'LoginScreen',
        action: 'handleSubmit',
        status: error.response?.status,
      });
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const resetInputs = useCallback(() => {
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
  }, []);

  const handleCountrySelect = useCallback((country) => {
    setSelectedCountry(country.code);
    setSearch('');
    setIsCountryInputFocused(false);
  }, []);

  const handleCountryKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && filteredCountries.length > 0) {
        e.preventDefault();
        handleCountrySelect(filteredCountries[0]);
      }
    },
    [filteredCountries, handleCountrySelect]
  );

  const handleCountryChange = useCallback(
    (e) => {
      setSearch(sanitizeInput(e.target.value));
      if (selectedCountry) {
        setSelectedCountry('');
      }
    },
    [selectedCountry, sanitizeInput]
  );

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (countryInputRef.current && !countryInputRef.current.contains(e.target)) {
        if (filteredCountries.length > 0 && search) {
          handleCountrySelect(filteredCountries[0]);
        }
        setIsCountryInputFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [filteredCountries, search, handleCountrySelect]);

  const getCountryInputValue = useCallback(() => {
    if (search) return search;
    if (selectedCountry) {
      const country = countries.find((c) => c.code === selectedCountry);
      return country ? country.name : '';
    }
    return '';
  }, [countries, search, selectedCountry]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -50 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900"
      role="main"
      aria-label={isLogin ? 'Login Page' : 'Registration Page'}
    >
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md">
        <h2 className="text-2xl font-bold mb-4 text-primary dark:text-white text-center">
          {isLogin ? 'Login' : 'Register'}
        </h2>
        {error && (
          <p className="text-red-500 mb-4 text-center text-sm" role="alert">
            {error}
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {!isLogin && (
            <>
              <div>
                <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Username
                </label>
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(sanitizeInput(e.target.value))}
                  className="w-full p-2 mt-1 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="Username (3-20 characters)"
                  disabled={loading}
                  aria-required="true"
                  aria-describedby="username-error"
                />
              </div>
              <div className="relative" ref={countryInputRef}>
                <label htmlFor="country" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Country
                </label>
                <input
                  id="country"
                  type="text"
                  value={getCountryInputValue()}
                  onChange={handleCountryChange}
                  onFocus={() => setIsCountryInputFocused(true)}
                  onKeyDown={handleCountryKeyDown}
                  className="w-full p-2 mt-1 border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="Select a country"
                  disabled={loading || countryLoading}
                  aria-required="true"
                  aria-describedby="country-error"
                />
                {isCountryInputFocused && (
                  <div className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                    <ul role="listbox" aria-label="Country selection">
                      {countryLoading ? (
                        <li className="p-2 text-gray-500 dark:text-gray-400">Loading countries...</li>
                      ) : filteredCountries.length > 0 ? (
                        filteredCountries.map((c, index) => (
                          <li
                            key={c.code}
                            onClick={() => handleCountrySelect(c)}
                            className={`p-2 cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 ${
                              index === 0 ? 'bg-gray-100 dark:bg-gray-600' : ''
                            }`}
                            role="option"
                            aria-selected={index === 0}
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && handleCountrySelect(c)}
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
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(sanitizeInput(e.target.value))}
              className="w-full p-2 mt-1 border rounded-md dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="Email"
              required
              disabled={loading}
              aria-required="true"
              aria-describedby="email-error"
            />
          </div>
          <div className="relative">
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Password
            </label>
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-2 mt-1 border rounded-md dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="Password (min 8 characters)"
              required
              disabled={loading}
              aria-required="true"
              aria-describedby="password-error"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 transform translate-y-1/4 text-gray-500 dark:text-gray-300 focus:outline-none"
              disabled={loading}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <FaEyeSlash size={20} /> : <FaEye size={20} />}
            </button>
          </div>
          {!isLogin && (
            <div className="relative">
              <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Confirm Password
              </label>
              <input
                id="confirm-password"
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full p-2 mt-1 border rounded-md dark:bg-gray-700 dark:text-white dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Confirm Password"
                required
                disabled={loading}
                aria-required="true"
                aria-describedby="confirm-password-error"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-2 top-1/2 transform translate-y-1/4 text-gray-500 dark:text-gray-300 focus:outline-none"
                disabled={loading}
                aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
              >
                {showConfirmPassword ? <FaEyeSlash size={20} /> : <FaEye size={20} />}
              </button>
            </div>
          )}
          <button
            type="submit"
            className={`w-full bg-primary text-white p-2 rounded-lg hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-primary ${
              loading || countryLoading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
            disabled={loading || countryLoading}
            aria-label={isLogin ? 'Login' : 'Register'}
          >
            {loading || countryLoading ? 'Processing...' : isLogin ? 'Login' : 'Register'}
          </button>
        </form>
        <p className="mt-4 text-center text-gray-600 dark:text-gray-300 text-sm">
          {isLogin ? "Don't have an account?" : 'Already have an account?'}{' '}
          <span
            onClick={() => {
              if (!loading && !countryLoading) {
                setIsLogin(!isLogin);
                resetInputs();
              }
            }}
            className={`text-primary cursor-pointer hover:underline focus:outline-none ${
              loading || countryLoading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && !loading && !countryLoading && (setIsLogin(!isLogin), resetInputs())}
            aria-label={isLogin ? 'Switch to Register' : 'Switch to Login'}
          >
            {isLogin ? 'Register' : 'Login'}
          </span>
        </p>
      </div>
    </motion.div>
  );
};

export default LoginScreen;