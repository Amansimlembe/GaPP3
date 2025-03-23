import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { FaEdit, FaSignOutAlt, FaTrash, FaEllipsisH, FaMoon, FaSun } from 'react-icons/fa';
import io from 'socket.io-client';

const socket = io('https://gapp-6yc3.onrender.com');

const ProfileScreen = ({ token, userId, setAuth }) => {
  const [cvFile, setCvFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [username, setUsername] = useState(localStorage.getItem('username') || '');
  const [editUsername, setEditUsername] = useState(false);
  const [error, setError] = useState('');
  const [photoUrl, setPhotoUrl] = useState(localStorage.getItem('photo') || '');
  const [myPosts, setMyPosts] = useState([]);
  const [showPosts, setShowPosts] = useState(false);
  const [selectedPost, setSelectedPost] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null);
  const [darkMode, setDarkMode] = useState(localStorage.getItem('darkMode') === 'true');

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const { data } = await axios.get(`/auth/user/${userId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setUsername(data.username || '');
        localStorage.setItem('username', data.username || '');
        setPhotoUrl(data.photo || '');
        localStorage.setItem('photo', data.photo || '');
      } catch (error) {
        console.error('Fetch user error:', error);
      }
    };
    fetchUser();

    const fetchMyPosts = async () => {
      try {
        const { data } = await axios.get(`/social/my-posts/${userId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setMyPosts(data);
      } catch (error) {
        console.error('Fetch my posts error:', error);
      }
    };
    fetchMyPosts();

    socket.on('postDeleted', (postId) => setMyPosts((prev) => prev.filter(p => p._id !== postId)));
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('darkMode', darkMode);
    return () => socket.off('postDeleted');
  }, [token, userId, darkMode]);

  const uploadCV = async () => {
    if (!cvFile) { setError('Please select a CV file'); return; }
    const formData = new FormData();
    formData.append('cv_file', cvFile);
    formData.append('userId', userId);
    try {
      await axios.post('/jobseeker/update_cv', formData, { headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` } });
      alert('CV uploaded successfully');
      setError('');
    } catch (error) {
      console.error('CV upload error:', error);
      setError(error.response?.data?.error || 'Failed to upload CV');
    }
  };

  const uploadPhoto = async () => {
    if (!photoFile) { setError('Please select a photo'); return; }
    const formData = new FormData();
    formData.append('photo', photoFile);
    formData.append('userId', userId);
    try {
      const { data } = await axios.post('/auth/update_photo', formData, { headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` } });
      setPhotoUrl(data.photo);
      localStorage.setItem('photo', data.photo);
      alert('Photo uploaded successfully');
      setError('');
    } catch (error) {
      console.error('Photo upload error:', error);
      setError(error.response?.data?.error || 'Failed to upload photo');
    }
  };

  const updateUsername = async () => {
    if (!username) { setError('Please enter a username'); return; }
    try {
      await axios.post('/auth/update_username', { userId, username }, { headers: { Authorization: `Bearer ${token}` } });
      localStorage.setItem('username', username);
      alert('Username updated successfully');
      setEditUsername(false);
      setError('');
    } catch (error) {
      console.error('Username update error:', error);
      setError(error.response?.data?.error || 'Failed to update username');
    }
  };

  const deletePost = async (postId) => {
    try {
      const response = await axios.delete(`/social/post/${postId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.data.success) {
        socket.emit('postDeleted', postId);
        setMyPosts((prev) => prev.filter(post => post._id !== postId));
        setShowDeleteConfirm(null);
        setSelectedPost(null);
      }
    } catch (error) {
      console.error('Delete post error:', error);
      setError(error.response?.data?.error || 'Failed to delete post');
    }
  };

  const logout = () => {
    setAuth(null, null, null, '');
    localStorage.clear();
  };

  return (
    <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5 }} className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg max-w-md mx-auto mt-6 mb-20">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold text-primary dark:text-gray-300">Profile</h2>
        <div className="flex space-x-2">
          <motion.button whileHover={{ scale: 1.1 }} onClick={() => setDarkMode(!darkMode)} className="text-2xl text-primary dark:text-gray-300">
            {darkMode ? <FaSun /> : <FaMoon />}
          </motion.button>
          <FaSignOutAlt onClick={logout} className="text-2xl text-primary dark:text-gray-300 cursor-pointer hover:text-secondary" />
        </div>
      </div>
      <p className="text-gray-700 dark:text-gray-300 mb-4">Your User ID: <span className="font-semibold">{userId}</span></p>
      {photoUrl && <img src={photoUrl} alt="Profile" className="w-20 h-20 rounded-full mb-4 mx-auto" />}
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <div className="mb-4 flex items-center">
        <label className="block text-gray-700 dark:text-gray-300 mr-2">Username:</label>
        {editUsername ? (
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="flex-1 p-2 border rounded-lg dark:bg-gray-700 dark:text-white"
            placeholder="Enter unique username"
          />
        ) : (
          <span className="flex-1">{username || 'Not set'}</span>
        )}
        <FaEdit onClick={() => setEditUsername(!editUsername)} className="ml-2 text-xl text-primary dark:text-gray-300 cursor-pointer hover:text-secondary" />
        {editUsername && <button onClick={updateUsername} className="ml-2 bg-primary text-white p-1 rounded-lg dark:bg-gray-700">Save</button>}
      </div>
      <div className="mb-4">
        <label className="block text-gray-700 dark:text-gray-300 mb-2">Upload CV (PDF)</label>
        <input type="file" accept=".pdf" onChange={(e) => setCvFile(e.target.files[0])} className="w-full p-3 border rounded-lg dark:bg-gray-700 dark:text-white" />
        <button onClick={uploadCV} className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary w-full dark:bg-gray-700">Upload CV</button>
      </div>
      <div className="mb-4">
        <label className="block text-gray-700 dark:text-gray-300 mb-2">Upload Profile Photo</label>
        <input type="file" accept="image/*" onChange={(e) => setPhotoFile(e.target.files[0])} className="w-full p-3 border rounded-lg dark:bg-gray-700 dark:text-white" />
        <button onClick={uploadPhoto} className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary w-full dark:bg-gray-700">Upload Photo</button>
      </div>
      <button onClick={() => setShowPosts(!showPosts)} className="bg-primary text-white p-2 rounded-lg w-full hover:bg-secondary dark:bg-gray-700">
        {showPosts ? 'Hide My Posts' : 'Show My Posts'}
      </button>
      {showPosts && (
        <div className="mt-4 overflow-y-auto max-h-96">
          <div className="grid grid-cols-3 gap-2">
            {myPosts.map((post) => (
              <div key={post._id} className="relative">
                {post.contentType === 'image' && <img src={post.content} alt="Post" className="w-full h-32 object-cover rounded lazy-load" loading="lazy" />}
                {post.contentType === 'video' && <video src={post.content} className="w-full h-32 object-cover rounded lazy-load" loading="lazy" />}
                <FaEllipsisH
                  onClick={() => setSelectedPost(selectedPost === post._id ? null : post._id)}
                  className="absolute top-1 right-1 text-white dark:text-gray-300 cursor-pointer hover:text-primary"
                />
                {selectedPost === post._id && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute top-6 right-1 bg-white dark:bg-gray-800 p-2 rounded shadow-lg"
                  >
                    <button onClick={() => setShowDeleteConfirm(post._id)} className="flex items-center text-red-500 hover:text-red-700 dark:text-red-400">
                      <FaTrash className="mr-1" /> Delete
                    </button>
                  </motion.div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {showDeleteConfirm && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
        >
          <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-lg">
            <p className="mb-4 text-black dark:text-gray-300">Are you sure you want to delete this post?</p>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setShowDeleteConfirm(null)} className="bg-gray-300 dark:bg-gray-600 p-2 rounded hover:bg-gray-400 dark:text-white">Cancel</button>
              <button onClick={() => deletePost(showDeleteConfirm)} className="bg-red-500 text-white p-2 rounded hover:bg-red-700">Delete</button>
            </div>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
};

export default ProfileScreen;