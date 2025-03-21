import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const ProfileScreen = () => {
  const [cvFile, setCvFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [error, setError] = useState('');
  const [userId, setUserId] = useState('');

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('user'));
    if (user) setUserId(user.userId);
  }, []);

  const uploadCV = async () => {
    const formData = new FormData();
    formData.append('cv_file', cvFile);
    const user = JSON.parse(localStorage.getItem('user'));
    formData.append('userId', user.userId);
    try {
      await axios.post('/jobseeker/update_cv', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      alert('CV uploaded successfully');
      setError('');
    } catch (error) {
      console.error('CV upload error:', error);
      setError(error.response?.data?.error || 'Failed to upload CV. Please try again.');
    }
  };

  const uploadPhoto = async () => {
    const formData = new FormData();
    formData.append('photo', photoFile);
    const user = JSON.parse(localStorage.getItem('user'));
    formData.append('userId', user.userId);
    try {
      const { data } = await axios.post('/auth/update_photo', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      const updatedUser = { ...user, photo: data.photo };
      localStorage.setItem('user', JSON.stringify(updatedUser));
      window.location.reload();
    } catch (error) {
      console.error('Photo upload error:', error);
      setError(error.response?.data?.error || 'Failed to upload photo. Please try again.');
    }
  };

  return (
    <motion.div
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="bg-white p-6 rounded-lg shadow-lg max-w-md mx-auto mt-6"
    >
      <h2 className="text-xl font-bold text-primary mb-4">Profile</h2>
      <p className="text-gray-700 mb-4">Your User ID: <span className="font-semibold">{userId}</span></p>
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <div className="mb-4">
        <label className="block text-gray-700 mb-2">Upload CV (PDF)</label>
        <input type="file" accept=".pdf" onChange={(e) => setCvFile(e.target.files[0])} className="w-full p-3 border rounded-lg" />
        <button onClick={uploadCV} className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary transition duration-300 w-full">Upload CV</button>
      </div>
      <div>
        <label className="block text-gray-700 mb-2">Upload Profile Photo</label>
        <input type="file" accept="image/*" onChange={(e) => setPhotoFile(e.target.files[0])} className="w-full p-3 border rounded-lg" />
        <button onClick={uploadPhoto} className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary transition duration-300 w-full">Upload Photo</button>
      </div>
    </motion.div>
  );
};

export default ProfileScreen;