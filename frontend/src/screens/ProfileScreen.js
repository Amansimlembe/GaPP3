import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const ProfileScreen = () => {
  const [cvFile, setCvFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [error, setError] = useState('');
  const [userId, setUserId] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');

  useEffect(() => {
    // Fetch user data from API instead of local storage
    const fetchUserData = async () => {
      try {
        const { data } = await axios.post('/auth/login', {
          email: 'user@example.com', // Replace with actual auth logic
          password: 'password',      // Replace with actual auth logic
        });
        setUserId(data.userId);
        setPhotoUrl(data.photo || '');
      } catch (err) {
        console.error('Failed to fetch user data:', err);
        setError('Unable to load user data');
      }
    };
    fetchUserData();
  }, []);

  const uploadCV = async () => {
    if (!cvFile || !userId) {
      setError('Please select a CV file');
      return;
    }
    const formData = new FormData();
    formData.append('cv_file', cvFile);
    formData.append('userId', userId);
    try {
      const { data } = await axios.post('/jobseeker/update_cv', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      alert('CV uploaded successfully');
      setError('');
    } catch (error) {
      console.error('CV upload error:', error);
      setError(error.response?.data?.error || 'Failed to upload CV. Please try again.');
    }
  };

  const uploadPhoto = async () => {
    if (!photoFile || !userId) {
      setError('Please select a photo');
      return;
    }
    const formData = new FormData();
    formData.append('photo', photoFile);
    formData.append('userId', userId);
    try {
      const { data } = await axios.post('/auth/update_photo', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setPhotoUrl(data.photo);
      alert('Photo uploaded successfully');
      setError('');
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
      {photoUrl && <img src={photoUrl} alt="Profile" className="w-20 h-20 rounded-full mb-4 mx-auto" />}
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <div className="mb-4">
        <label className="block text-gray-700 mb-2">Upload CV (PDF)</label>
        <input
          type="file"
          accept=".pdf"
          onChange={(e) => setCvFile(e.target.files[0])}
          className="w-full p-3 border rounded-lg"
        />
        <button
          onClick={uploadCV}
          className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary transition duration-300 w-full"
        >
          Upload CV
        </button>
      </div>
      <div>
        <label className="block text-gray-700 mb-2">Upload Profile Photo</label>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setPhotoFile(e.target.files[0])}
          className="w-full p-3 border rounded-lg"
        />
        <button
          onClick={uploadPhoto}
          className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary transition duration-300 w-full"
        >
          Upload Photo
        </button>
      </div>
    </motion.div>
  );
};

export default ProfileScreen;