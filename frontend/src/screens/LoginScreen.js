import React, { useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const LoginScreen = ({ setUser }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('0');
  const [photo, setPhoto] = useState(null);
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const register = async () => {
    try {
      const formData = new FormData();
      formData.append('email', email);
      formData.append('password', password);
      formData.append('role', role);
      if (photo) formData.append('photo', photo);
      const { data } = await axios.post('/auth/register', formData);
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
      const userData = { userId: data.userId, role: data.role, photo: data.photo };
      localStorage.setItem('user', JSON.stringify(userData));
      setUser(data.userId, data.role, data.photo);
      setError('');
      setSuccess(data.message);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
      setSuccess('');
    }
  };

  const handleSubmit = () => (isRegistering ? register() : login());

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-lg w-full max-w-md">
        <h2 className="text-2xl font-bold text-primary mb-6">{isRegistering ? 'Register for GaPP' : 'Login to GaPP'}</h2>
        {error && <p className="text-red-500 mb-4">{error}</p>}
        {success && <p className="text-green-500 mb-4">{success}</p>}
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full p-3 mb-4 border rounded focus:outline-none focus:ring-2 focus:ring-primary" />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full p-3 mb-4 border rounded focus:outline-none focus:ring-2 focus:ring-primary" />
        {isRegistering && (
          <>
            <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full p-3 mb-4 border rounded focus:outline-none focus:ring-2 focus:ring-primary">
              <option value="0">Job Seeker</option>
              <option value="1">Employer</option>
            </select>
            <input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files[0])} className="w-full p-3 mb-4 border rounded" />
          </>
        )}
        <button onClick={handleSubmit} className="w-full bg-primary text-white p-3 rounded hover:bg-secondary transition duration-300">
          {isRegistering ? 'Register' : 'Login'}
        </button>
        <button onClick={() => setIsRegistering(!isRegistering)} className="w-full mt-4 text-primary hover:underline">
          {isRegistering ? 'Already have an account? Login' : 'Need an account? Register'}
        </button>
      </div>
    </motion.div>
  );
};

export default LoginScreen;