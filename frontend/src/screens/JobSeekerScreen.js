import React, { useState, useEffect } from 'react';
import axios from 'axios';
import JobCard from '../components/JobCard';
import { motion } from 'framer-motion';

const JobSeekerScreen = () => {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchJobs = async () => {
      try {
        const user = JSON.parse(localStorage.getItem('user'));
        const { data } = await axios.get(`/jobseeker/jobs?userId=${user.userId}`);
        setJobs(data.jobs);
        setError('');
      } catch (error) {
        console.error('Failed to fetch jobs:', error);
        setError('Failed to load jobs. Please try again.');
      }
    };
    fetchJobs();
  }, []);

  const applyToJob = async (jobId) => {
    const formData = new FormData();
    const user = JSON.parse(localStorage.getItem('user'));
    formData.append('userId', user.userId);
    formData.append('jobId', jobId);
    try {
      await axios.post('/jobseeker/apply', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      alert('Application submitted');
    } catch (error) {
      console.error('Failed to apply:', error);
      alert('Failed to apply. Please try again.');
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-6">
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {jobs.map((job) => (
          <JobCard key={job._id} job={job} onApply={() => applyToJob(job._id)} />
        ))}
      </div>
    </motion.div>
  );
};

export default JobSeekerScreen;