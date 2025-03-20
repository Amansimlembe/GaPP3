import React from 'react';

const JobCard = ({ job }) => (
  <div style={{ padding: 10, borderBottom: '1px solid #ccc' }}>
    <h3>{job.title} ({job.matchScore}% Match)</h3>
    <p>{job.description}</p>
    <button>Apply</button>
  </div>
);

export default JobCard;