import React, { useState, useEffect } from 'react';
import axios from 'axios';
import JobCard from '../components/JobCard';

const JobSeekerScreen = () => {
  const [jobs, setJobs] = useState([]);

  useEffect(() => {
    const fetchJobs = async () => {
      const user = JSON.parse(localStorage.getItem('user'));
      const { data } = await axios.get(`/jobseeker/jobs?userId=${user.userId}`);
      setJobs(data.jobs);
    };
    fetchJobs();
  }, []);

  const applyJob = async (jobId) => {
    const user = JSON.parse(localStorage.getItem('user'));
    await axios.post('/jobseeker/apply', { userId: user.userId, jobId });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {jobs.map((job) => (
        <JobCard key={job._id} job={job} onApply={() => applyJob(job._id)} />
      ))}
    </div>
  );
};

export default JobSeekerScreen;