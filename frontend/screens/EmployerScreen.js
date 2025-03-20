import React, { useState } from 'react';
import axios from 'axios';

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
    <div>
      <input placeholder="Job Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button onClick={postJob}>Post Job</button>
    </div>
  );
};

export default EmployerScreen;