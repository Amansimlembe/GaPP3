import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaEdit, FaSignOutAlt, FaTrash, FaEllipsisH, FaMoon, FaSun } from 'react-icons/fa';
import { useDispatch } from 'react-redux';
import { setAuth } from '../store';
import PropTypes from 'prop-types';

const ProfileScreen = ({ token, userId, socket, username: initialUsername, virtualNumber: initialVirtualNumber, photo: initialPhoto, onLogout, toggleTheme, theme }) => {
  const dispatch = useDispatch();
  const [cvFile, setCvFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [username, setUsername] = useState(initialUsername || localStorage.getItem('username') || '');
  const [virtualNumber] = useState(initialVirtualNumber || localStorage.getItem('virtualNumber') || '');
  const [editUsername, setEditUsername] = useState(false);
  const [error, setError] = useState('');
  const [photoUrl, setPhotoUrl] = useState(initialPhoto || localStorage.getItem('photo') || 'https://placehold.co/40x40');
  const [myPosts, setMyPosts] = useState([]);
  const [showPosts, setShowPosts] = useState(false);
  const [selectedPost, setSelectedPost] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null);
  const [loading, setLoading] = useState(false);

  const retryRequest = async (method, url, data, config, retries = 3, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
      try {
        const response = method === 'get'
          ? await axios.get(url, config)
          : await axios.post(url, data, config);
        return response.data;
      } catch (err) {
        console.log(`Attempt ${i + 1} failed:`, err.response?.data || err.message);
        if ((err.response?.status === 429 || err.response?.status >= 500) && i < retries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
          continue;
        }
        throw err;
      }
    }
  };

  useEffect(() => {
    if (!token || !userId) {
      setError('Authentication required. Please log in again.');
      onLogout();
      return;
    }

    socket.emit('join', userId);

    const fetchMyPosts = async () => {
      setLoading(true);
      try {
        const data = await retryRequest('get', `https://gapp-6yc3.onrender.com/social/my-posts/${userId}`, null, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setMyPosts(data || []);
        setError('');
      } catch (error) {
        setError(`Failed to load posts: ${error.response?.data?.error || error.message}`);
        if (error.response?.status === 401) {
          onLogout();
        }
      } finally {
        setLoading(false);
      }
    };

    fetchMyPosts();

    socket.on('postDeleted', (postId) => {
      setMyPosts((prev) => prev.filter((p) => p._id !== postId));
    });

    socket.on('onlineStatus', ({ userId: updatedUserId, status, lastSeen }) => {
      if (updatedUserId === userId) {
        console.log(`User ${userId} is now ${status}, last seen: ${lastSeen}`);
      }
    });

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
      setError('Connection lost. Trying to reconnect...');
    });

    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);

    return () => {
      socket.off('postDeleted');
      socket.off('onlineStatus');
      socket.off('connect_error');
      socket.disconnect(); // Add explicit disconnect
      socket.emit('leave', userId);
    };
  }, [token, userId, socket, theme, onLogout]);

  const handlePhotoChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setPhotoFile(file);
      setPhotoPreview(URL.createObjectURL(file));
    }
  };

  const uploadCV = async () => {
    if (!cvFile) {
      setError('Please select a CV file');
      return;
    }
    setLoading(true);
    const formData = new FormData();
    formData.append('cv_file', cvFile);
    formData.append('userId', userId);
    try {
      await retryRequest('post', 'https://gapp-6yc3.onrender.com/jobseeker/update_cv', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      setCvFile(null);
      setError('');
      alert('CV uploaded successfully');
    } catch (error) {
      setError(error.response?.data?.error || 'Failed to upload CV');
      if (error.response?.status === 401) {
        onLogout();
      }
    } finally {
      setLoading(false);
    }
  };

  const uploadPhoto = async () => {
    if (!photoFile) {
      setError('Please select a photo');
      return;
    }
    setLoading(true);
    const formData = new FormData();
    formData.append('photo', photoFile);
    formData.append('userId', userId);
    try {
      const data = await retryRequest('post', 'https://gapp-6yc3.onrender.com/auth/update_photo', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      setPhotoUrl(data.photo);
      localStorage.setItem('photo', data.photo);
      dispatch(setAuth({ token, userId, username, virtualNumber, photo: data.photo }));
      setPhotoFile(null);
      setPhotoPreview(null);
      setError('');
      alert('Photo uploaded successfully');
    } catch (error) {
      setError(error.response?.data?.error || 'Failed to upload photo');
      if (error.response?.status === 401) {
        onLogout();
      }
    } finally {
      setLoading(false);
    }
  };

  const updateUsername = async () => {
    if (!username.trim()) {
      setError('Please enter a valid username');
      return;
    }
    setLoading(true);
    try {
      const data = await retryRequest('post', 'https://gapp-6yc3.onrender.com/auth/update_username', { userId, username }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setUsername(data.username);
      localStorage.setItem('username', data.username);
      dispatch(setAuth({ token, userId, username: data.username, virtualNumber, photo: photoUrl }));
      setEditUsername(false);
      setError('');
      alert('Username updated successfully');
    } catch (error) {
      setError(error.response?.data?.error || 'Failed to update username');
      if (error.response?.status === 401) {
        onLogout();
      }
    } finally {
      setLoading(false);
    }
  };

  const deletePost = async (postId) => {
    setLoading(true);
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
      setError(error.response?.data?.error || 'Failed to delete post');
      if (error.response?.status === 401) {
        onLogout();
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen bg-gray-100 dark:bg-gray-900 p-6 flex items-center justify-center"
    >
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg max-w-md w-full">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-primary dark:text-gray-100">Profile</h2>
          <div className="flex space-x-3">
            <motion.button
              whileHover={{ scale: 1.1 }}
              onClick={toggleTheme}
              className="text-2xl text-primary dark:text-gray-100 hover:text-secondary"
              disabled={loading}
            >
              {theme === 'dark' ? <FaSun /> : <FaMoon />}
            </motion.button>
            <FaSignOutAlt
              onClick={onLogout}
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
          <img src={photoPreview || photoUrl} alt="Profile" className="w-24 h-24 rounded-full mb-4 object-cover photo-preview" />
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
                  disabled={loading}
                />
                <button
                  onClick={updateUsername}
                  className="ml-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary"
                  disabled={loading}
                >
                  {loading ? 'Saving...' : 'Save'}
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
            disabled={loading}
          />
          <button
            onClick={uploadCV}
            className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary w-full disabled:opacity-50"
            disabled={!cvFile || loading}
          >
            {loading ? 'Uploading...' : 'Upload CV'}
          </button>
        </div>

        <div className="mb-4">
          <label className="block text-gray-700 dark:text-gray-300 mb-2">Update Profile Photo</label>
          <input
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            className="w-full p-3 border rounded-lg dark:bg-gray-700 dark:text-white"
            disabled={loading}
          />
          <button
            onClick={uploadPhoto}
            className="mt-2 bg-primary text-white p-2 rounded-lg hover:bg-secondary w-full disabled:opacity-50"
            disabled={!photoFile || loading}
          >
            {loading ? 'Uploading...' : 'Update Photo'}
          </button>
        </div>

        <button
          onClick={() => setShowPosts(!showPosts)}
          className="bg-primary text-white p-2 rounded-lg w-full hover:bg-secondary disabled:opacity-50"
          disabled={loading}
        >
          {loading ? 'Loading...' : showPosts ? 'Hide My Posts' : 'Show My Posts'}
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
                            disabled={loading}
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
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 menu-overlay"
          >
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg menu-content">
              <p className="mb-4 text-black dark:text-gray-100">Are you sure you want to delete this post?</p>
              <div className="flex justify-end space-x-4">
                <button
                  onClick={() => setShowDeleteConfirm(null)}
                  className="bg-gray-300 dark:bg-gray-600 text-black dark:text-white p-2 rounded hover:bg-gray-400 disabled:opacity-50"
                  disabled={loading}
                >
                  Cancel
                </button>
                <button
                  onClick={() => deletePost(showDeleteConfirm)}
                  className="bg-red-500 text-white p-2 rounded hover:bg-red-700 disabled:opacity-50"
                  disabled={loading}
                >
                  {loading ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
};

ProfileScreen.propTypes = {
  token: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  socket: PropTypes.object.isRequired,
  username: PropTypes.string,
  virtualNumber: PropTypes.string,
  photo: PropTypes.string,
  onLogout: PropTypes.func.isRequired,
  toggleTheme: PropTypes.func.isRequired,
};

export default ProfileScreen;