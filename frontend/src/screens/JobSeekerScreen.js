import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const JobSeekerScreen = ({ token, userId }) => {
  const [jobs, setJobs] = useState([]);
  const [file, setFile] = useState(null);
  const [contentType, setContentType] = useState('image');
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchJobs = async () => {
      try {
        const { data } = await axios.get('/jobseeker/jobs', {
          headers: { Authorization: `Bearer ${token}` },
          params: { userId },
        });
        setJobs(data.jobs || []);
      } catch (error) {
        console.error('Failed to fetch jobs:', error);
        setError('Failed to fetch jobs');
      }
    };
    if (userId) fetchJobs();
  }, [token, userId]);

  const postMedia = async () => {
    if (!file) {
      setError('Please select a file');
      return;
    }
    const formData = new FormData();
    formData.append('content', file);
    formData.append('contentType', contentType);
    try {
      const { data } = await axios.post('/social/post', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      setJobs((prev) => [...prev, { _id: data._id, title: 'Posted Media', content: data.content, contentType: data.contentType }]);
      setFile(null);
      setError('');
    } catch (error) {
      console.error('Post media error:', error);
      setError(error.response?.data?.error || 'Failed to post media');
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="p-6">
      <div className="mb-6">
        <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="p-2 border rounded-lg">
          <option value="image">Image</option>
          <option value="video">Video</option>
        </select>
        <input
          type="file"
          accept={contentType === 'image' ? 'image/*' : 'video/*'}
          onChange={(e) => setFile(e.target.files[0])}
          className="p-2 border rounded-lg ml-2"
        />
        <button onClick={postMedia} className="bg-primary text-white p-2 rounded-lg hover:bg-secondary transition duration-300 ml-2">Post Media</button>
      </div>
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {jobs.map((job) => (
          <div key={job._id} className="bg-white p-4 rounded-lg shadow-md">
            <h3 className="text-lg font-semibold text-primary">{job.title}</h3>
            <p className="text-gray-600 mt-2">{job.description || 'Media Post'}</p>
            {job.content && (
              job.contentType === 'image' ? (
                <img src={job.content} alt="Job" className="mt-2 max-w-full h-auto" onError={(e) => console.log('Image load error:', job.content)} />
              ) : job.contentType === 'video' ? (
                <video controls src={job.content} className="mt-2 max-w-full h-auto" onError={(e) => console.log('Video load error:', job.content)} />
              ) : null
            )}
          </div>
        ))}
      </div>
    </motion.div>
  );
};

export default JobSeekerScreen;