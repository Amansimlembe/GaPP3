import React from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const ProfileScreen = () => {
  const uploadCV = async (e) => {
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('cv_file', file);
    const user = JSON.parse(localStorage.getItem('user'));
    formData.append('userId', user.userId);
    await axios.post('/jobseeker/update_cv', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
  };

  return (
    <motion.div
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="bg-white p-6 rounded-lg shadow-lg"
    >
      <h2 className="text-xl font-bold text-primary mb-4">Upload CV</h2>
      <input
        type="file"
        accept=".pdf"
        onChange={uploadCV}
        className="w-full p-3 border rounded focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </motion.div>
  );
};

export default ProfileScreen;