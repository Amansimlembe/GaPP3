import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const EmployerScreen = ({ token }) => {
  const [jobs, setJobs] = useState([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchJobs = async () => {
      try {
        const { data } = await axios.get('/jobseeker/jobs', { // Adjust endpoint if needed
          headers: { Authorization: `Bearer ${token}` },
        });
        setJobs(Array.isArray(data.jobs) ? data.jobs : []);
        setError('');
      } catch (error) {
        console.error('Failed to fetch jobs:', error);
        setError('Failed to load jobs');
        setJobs([]);
      }
    };
    fetchJobs();
  }, [token]);

  const postJob = async () => {
    try {
      await axios.post('/employer/jobs', { title, description }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      alert('Job posted successfully');
      setTitle('');
      setDescription('');
      window.location.reload();
    } catch (error) {
      console.error('Job post error:', error);
      setError('Failed to post job');
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-6">
      <div className="bg-white p-4 rounded-lg shadow-md mb-6">
        <input
          placeholder="Job Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full p-2 mb-2 border rounded-lg"
        />
        <textarea
          placeholder="Job Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full p-2 mb-2 border rounded-lg"
        />
        <button
          onClick={postJob}
          className="bg-primary text-white p-2 rounded-lg hover:bg-secondary transition duration-300 w-full"
        >
          Post Job
        </button>
      </div>
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {jobs.length > 0 ? (
          jobs.map((job) => (
            <div key={job._id} className="bg-white p-4 rounded-lg shadow-md">
              <h3 className="text-lg font-semibold text-primary">{job.title}</h3>
              <p className="text-gray-600 mt-2">{job.description}</p>
            </div>
          ))
        ) : (
          <p className="text-gray-600">No jobs available</p>
        )}
      </div>
    </motion.div>
  );
};

export default EmployerScreen;