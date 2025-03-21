import React from 'react';
import axios from 'axios';

const ProfileScreen = () => {
  const uploadCV = async (e) => {
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('cv_file', file);
    const user = JSON.parse(localStorage.getItem('user'));
    formData.append('userId', user.userId);
    await axios.post('/jobseeker/update_cv', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
  };

  return (
    <div>
      <input type="file" accept=".pdf" onChange={uploadCV} />
    </div>
  );
};

export default ProfileScreen;