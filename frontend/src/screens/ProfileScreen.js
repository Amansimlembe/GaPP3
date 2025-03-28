import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaEdit, FaSignOutAlt, FaTrash, FaEllipsisH, FaMoon, FaSun } from 'react-icons/fa';
import io from 'socket.io-client';

const socket = io('https://gapp-6yc3.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  withCredentials: true,
});

const ProfileScreen = ({ token, userId, setAuth, username: initialUsername, virtualNumber: initialVirtualNumber, photo: initialPhoto }) => {
  const [cvFile, setCvFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [username, setUsername] = useState(initialUsername || localStorage.getItem('username') || '');
  const [virtualNumber, setVirtualNumber] = useState(initialVirtualNumber || localStorage.getItem('virtualNumber') || '');
  const [editUsername, setEditUsername] = useState(false);
  const [error, setError] = useState('');
  const [photoUrl, setPhotoUrl] = useState(initialPhoto || localStorage.getItem('photo') || 'https://placehold.co/100x100');
  const [myPosts, setMyPosts] = useState([]);
  const [showPosts, setShowPosts] = useState(false);
  const [selectedPost, setSelectedPost] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null);
  const [darkMode, setDarkMode] = useState(localStorage.getItem('darkMode') === 'true');

  useEffect(() => {
    if (!token || !userId) {
      setError('Authentication required. Please log in again.');
      return;
    }

    socket.emit('join', userId);

    const fetchMyPosts = async () => {
      try {
        const { data } = await axios.get(`https://gapp-6yc3.onrender.com/social/my-posts/${userId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setMyPosts(data);
      } catch (error) {
        console.error('Fetch my posts error:', error);
        setError('Failed to load posts. Please try again.');
      }
    };

    fetchMyPosts();

    socket.on('postDeleted', (postId) => {
      setMyPosts((prev) => prev.filter((p) => p._id !== postId));
    });

    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('darkMode', darkMode);

    return () => {
      socket.off('postDeleted');
      socket.emit('leave', userId);
    };
  }, [token, userId, darkMode]);

  const uploadCV = async () => {
    if (!cvFile) {
      setError('Please select a CV file');
      return;
    }
    const formData = new FormData();
    formData.append('cv_file', cvFile);
    formData.append('userId', userId);
    try {
      await axios.post('https://gapp-6yc3.onrender.com/jobseeker/update_cv', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      setCvFile(null);
      setError('');
      alert('CV uploaded successfully');
    } catch (error) {
      console.error('CV upload error:', error);
      setError(error.response?.data?.error || 'Failed to upload CV');
    }
  };

  const uploadPhoto = async () => {
    if (!photoFile) {
      setError('Please select a photo');
      return;
    }
    const formData = new FormData();
    formData.append('photo', photoFile);
    formData.append('userId', userId);
    try {
      const { data } = await axios.post('https://gapp-6yc3.onrender.com/auth/update_photo', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      setPhotoUrl(data.photo);
      localStorage.setItem('photo', data.photo);
      setPhotoFile(null);
      setError('');
      alert('Photo uploaded successfully');
    } catch (error) {
      console.error('Photo upload error:', error);
      setError(error.response?.data?.error || 'Failed to upload photo');
    }
  };

  const updateUsername = async () => {
    if (!username.trim()) {
      setError('Please enter a valid username');
      return;
    }
    try {
      await axios.post('https://gapp-6yc3.onrender.com/auth/update_username', { userId, username }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      localStorage.setItem('username', username);
      setEditUsername(false);
      setError('');
      alert('Username updated successfully');
    } catch (error) {
      console.error('Username update error:', error);
      setError(error.response?.data?.error || 'Failed to update username');
    }
  };

  const deletePost = async (postId) => {
    try {
      const response = await axios.delete(`https://gapp-6yc3.onrender.com/social/post/${postId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.data.success) {
        socket.emit('postDeleted', postId);
        setMyPosts((prev) => prev.filter((post) => post._id !== postId));
        setShowDeleteConfirm(null);
        setSelectedPost(null);
        setError('');
      }
    } catch (error) {
      console.error('Delete post error:', error);
      setError(error.response?.data?.error || 'Failed to delete post');
    }
  };

  const logout = () => {
    socket.emit('leave', userId);
    setAuth('', '', '', '', '', ''); // Matches 6 arguments from LoginScreen.js
    localStorage.clear();
  };

  return (
    <motion.div
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className={`min-h-screen bg-gray-100 dark:bg-gray-900 p-6 flex items-center justify-center`}
    >
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg max-w-md w-full">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-primary dark:text-gray-100">Profile</h2>
          <div className="flex space-x-3">
            <motion.button
              whileHover={{ scale: 1.1 }}
              onClick={() => setDarkMode(!darkMode)}
              className="text-2xl text-primary dark:text-gray-100 hover:text-secondary"
            >
              {darkMode ? <FaSun /> : <FaMoon />}
            </motion.button>
            <FaSignOutAlt
              onClick={logout}
              className="text-2xl text-primary dark:text-gray-100 cursor-pointer hover:text-red-500"
            />
          </div>
        </div>

        {error && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-red-500 mb-4 text-center"
          >
            {error}
          </motion.p>
        )}

        <div className="flex flex-col items-center mb-4">
          <img src={photoUrl} alt="Profile" className="w-24 h-24 rounded-full mb-4 object-cover" />
          <p className="text-gray-700 dark:text-gray-300 mb-2">
            Virtual Number: <span className="font-semibold">{virtualNumber}</span>
          </p>
          <div className="flex items-center w-full">
            <label className="text-gray-700 dark:text-gray-300 mr-2">Username:</label>
            {editUsername ? (
              <>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="flex-1 p-2 border rounded-lg dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-primary"
                  placeholder="Enter unique username"
                />
                <button
                  onClick={updateUsername}
                  className="ml-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary"
                >
                  Save
                </button>
              </>
            ) : (
              <span className="flex-1 text-gray-700 dark:text-gray-300">{username}</span>
            )}
            <FaEdit
              onClick={() => setEditUsername(!editUsername)}
              className="ml-2 text-xl text-primary dark:text-gray-100 cursor-pointer hover:text-secondary"
            />
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-gray-700 dark:text-gray-300 mb-2">Upload CV (PDF)</label>
          <input
            type="file"
            accept=".pdf"
            onChange={(e) => setCvFile(e.target.files[0])}
            className="w-full p-3 border rounded-lg dark:bg-gray-700 dark:text-white"
          />
          <button
            onClick={uploadCV}
            className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary w-full"
            disabled={!cvFile}
          >
            Upload CV
          </button>
        </div>

        <div className="mb-4">
          <label className="block text-gray-700 dark:text-gray-300 mb-2">Update Profile Photo</label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setPhotoFile(e.target.files[0])}
            className="w-full p-3 border rounded-lg dark:bg-gray-700 dark:text-white"
          />
          <button
            onClick={uploadPhoto}
            className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary w-full"
            disabled={!photoFile}
          >
            Update Photo
          </button>
        </div>

        <button
          onClick={() => setShowPosts(!showPosts)}
          className="bg-primary text-white p-2 rounded-lg w-full hover:bg-secondary"
        >
          {showPosts ? 'Hide My Posts' : 'Show My Posts'}
        </button>

        <AnimatePresence>
          {showPosts && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-4 overflow-y-auto max-h-96"
            >
              {myPosts.length === 0 ? (
                <p className="text-gray-500 dark:text-gray-400 text-center">No posts yet</p>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {myPosts.map((post) => (
                    <div key={post._id} className="relative">
                      {post.contentType === 'image' && (
                        <img src={post.content} alt="Post" className="w-full h-32 object-cover rounded lazy-load" loading="lazy" />
                      )}
                      {post.contentType === 'video' && (
                        <video src={post.content} className="w-full h-32 object-cover rounded lazy-load" loading="lazy" muted />
                      )}
                      <FaEllipsisH
                        onClick={() => setSelectedPost(selectedPost === post._id ? null : post._id)}
                        className="absolute top-1 right-1 text-white cursor-pointer hover:text-primary bg-black bg-opacity-50 p-1 rounded"
                      />
                      {selectedPost === post._id && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="absolute top-6 right-1 bg-white dark:bg-gray-800 p-2 rounded shadow-lg z-10"
                        >
                          <button
                            onClick={() => setShowDeleteConfirm(post._id)}
                            className="flex items-center text-red-500 hover:text-red-700 dark:text-red-400"
                          >
                            <FaTrash className="mr-1" /> Delete
                          </button>
                        </motion.div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {showDeleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          >
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg">
              <p className="mb-4 text-black dark:text-gray-100">Are you sure you want to delete this post?</p>
              <div className="flex justify-end space-x-4">
                <button
                  onClick={() => setShowDeleteConfirm(null)}
                  className="bg-gray-300 dark:bg-gray-600 text-black dark:text-white p-2 rounded hover:bg-gray-400"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deletePost(showDeleteConfirm)}
                  className="bg-red-500 text-white p-2 rounded hover:bg-red-700"
                >
                  Delete
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
};

export default ProfileScreen;