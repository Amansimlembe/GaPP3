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

  return (
    <div>
      {jobs.map((job) => (
        <JobCard key={job._id} job={job} />
      ))}
    </div>
  );
};

export default JobSeekerScreen;