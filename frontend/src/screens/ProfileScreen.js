import React, { useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const ProfileScreen = () => {
  const [cvFile, setCvFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);

  const uploadCV = async () => {
    const formData = new FormData();
    formData.append('cv_file', cvFile);
    const user = JSON.parse(localStorage.getItem('user'));
    formData.append('userId', user.userId);
    const { data } = await axios.post('/jobseeker/update_cv', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
    alert('CV uploaded successfully');
  };

  const uploadPhoto = async () => {
    const formData = new FormData();
    formData.append('photo', photoFile);
    const user = JSON.parse(localStorage.getItem('user'));
    formData.append('userId', user.userId);
    const { data } = await axios.post('/auth/update_photo', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
    const updatedUser = { ...user, photo: data.photo };
    localStorage.setItem('user', JSON.stringify(updatedUser));
    window.location.reload();
  };

  return (
    <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-white p-6 rounded-lg shadow-lg">
      <h2 className="text-xl font-bold text-primary mb-4">Profile</h2>
      <div className="mb-4">
        <label className="block text-gray-700 mb-2">Upload CV (PDF)</label>
        <input type="file" accept=".pdf" onChange={(e) => setCvFile(e.target.files[0])} className="w-full p-3 border rounded" />
        <button onClick={uploadCV} className="mt-2 bg-primary text-white p-2 rounded hover:bg-secondary transition duration-300">Upload CV</button>
      </div>
      <div>
        <label className="block text-gray-700 mb-2">Upload Profile Photo</label>
        <input type="file" accept="image/*" onChange={(e) => setPhotoFile(e.target.files[0])} className="w-full p-3 border rounded" />
        <button onClick={uploadPhoto} className="mt-2 bg-primary text-white p-2 rounded hover:bg-secondary transition duration-300">Upload Photo</button>
      </div>
    </motion.div>
  );
};

export default ProfileScreen;