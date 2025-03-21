import React, { useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const ProfileScreen = () => {
  const [cvFile, setCvFile] = useState(null);
  const [cvPath, setCvPath] = useState('');
  const [coverLetter, setCoverLetter] = useState('');

  const uploadCV = async () => {
    const formData = new FormData();
    formData.append('cv_file', cvFile);
    formData.append('userId', JSON.parse(localStorage.getItem('user')).userId);
    const { data } = await axios.post('/jobseeker/update_cv', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
    setCvPath(data.cvPath);
  };

  return (
    <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-white p-6 rounded-lg shadow-lg">
      <h2 className="text-xl font-bold text-primary mb-4">Profile</h2>
      <input type="file" accept=".pdf" onChange={(e) => setCvFile(e.target.files[0])} className="w-full p-3 mb-4 border rounded" />
      <button onClick={uploadCV} className="w-full bg-primary text-white p-3 rounded hover:bg-secondary transition duration-300">Upload CV</button>
      {cvPath && (
        <div className="mt-4">
          <a href={`https://gapp-6yc3.onrender.com${cvPath}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Preview CV</a>
        </div>
      )}
      <textarea placeholder="Cover Letter" value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} className="w-full p-3 mt-4 border rounded" />
    </motion.div>
  );
};

export default ProfileScreen;