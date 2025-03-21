import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const EmployerScreen = () => {
  const [title, setTitle] = useState('');
  const [jobs, setJobs] = useState([]);

  useEffect(() => {
    const fetchJobs = async () => {
      const user = JSON.parse(localStorage.getItem('user'));
      const { data } = await axios.get(`/employer/jobs?userId=${user.userId}`);
      setJobs(data);
    };
    fetchJobs();
  }, []);

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
    window.location.reload();
  };

  return (
    <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-white p-6 rounded-lg shadow-lg">
      <h2 className="text-xl font-bold text-primary mb-4">Post a Job</h2>
      <input
        placeholder="Job Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full p-3 mb-4 border rounded focus:outline-none focus:ring-2 focus:ring-primary"
      />
      <button onClick={postJob} className="w-full bg-primary text-white p-3 rounded hover:bg-secondary transition duration-300">Post Job</button>
      <h2 className="text-xl font-bold text-primary mt-6 mb-4">Your Jobs</h2>
      {jobs.map((job) => (
        <div key={job._id} className="mb-4">
          <h3 className="text-lg font-semibold">{job.title}</h3>
          {job.applications.map((app, idx) => (
            <div key={idx} className="p-4 bg-gray-100 rounded mt-2">
              <img src={app.photo} alt="Applicant" className="w-10 h-10 rounded-full inline-block mr-2" />
              <a href={app.cv} target="_blank" className="text-primary hover:underline">View CV</a>
              {app.coverLetter && <a href={app.coverLetter} target="_blank" className="ml-2 text-primary hover:underline">View Cover Letter</a>}
            </div>
          ))}
        </div>
      ))}
    </motion.div>
  );
};

export default EmployerScreen;