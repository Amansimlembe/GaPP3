import React, { useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const EmployerScreen = () => {
  const [title, setTitle] = useState('');

  const postJob = async () => {
    const user = JSON.parse(localStorage.getItem('user'));
    await axios.post('/employer/post_job', {
      userId: user.userId,
      title,
      description: 'Sample',
      requirements: 'Sample',
      deadline: '2025-12-31',
      employerEmail: 'test@example.com',
      companyName: 'Test Corp',
    });
    setTitle('');
  };

  return (
    <motion.div
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="bg-white p-6 rounded-lg shadow-lg"
    >
      <h2 className="text-xl font-bold text-primary mb-4">Post a Job</h2>
      <input
        placeholder="Job Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full p-3 mb-4 border rounded focus:outline-none focus:ring-2 focus:ring-primary"
      />
      <button
        onClick={postJob}
        className="w-full bg-primary text-white p-3 rounded hover:bg-secondary transition duration-300"
      >
        Post Job
      </button>
    </motion.div>
  );
};

export default EmployerScreen;