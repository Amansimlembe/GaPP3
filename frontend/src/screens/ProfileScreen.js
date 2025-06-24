import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaEdit, FaSignOutAlt, FaTrash, FaEllipsisH, FaMoon, FaSun } from 'react-icons/fa';
import io from 'socket.io-client';
import { useNavigate } from 'react-router-dom'; // Added: Import useNavigate

const BASE_URL = 'https://gapp-6yc3.onrender.com';
const socket = io(BASE_URL, {
  reconnection: true,
  reconnectionAttempts: 50, // Changed: Limit attempts
  reconnectionDelay: 500, // Changed: Faster initial retry
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  withCredentials: true,
});

const ProfileScreen = ({ token, userId, setAuth, username: initialUsername, virtualNumber: initialVirtualNumber, photo: initialPhoto }) => {
  const [cvFile, setCvFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [username, setUsername] = useState(initialUsername || '');
  const [virtualNumber, setVirtualNumber] = useState(initialVirtualNumber || '');
  const [editUsername, setEditUsername] = useState(false);
  const [error, setError] = useState('');
  const [photoUrl, setPhotoUrl] = useState(initialPhoto || 'https://placehold.co/40x40');
  const [myPosts, setMyPosts] = useState([]);
  const [showPosts, setShowPosts] = useState(false);
  const [selectedPost, setSelectedPost] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null);
  const [darkMode, setDarkMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1); // Changed: Add pagination
  const [hasMore, setHasMore] = useState(true); // Changed: Add pagination
  

      const [socket, setSocket] = useState(null); // Changed: Initialize socket in useEffect
  const navigate = useNavigate(); // Added: Initialize navigate

  // Changed: Optimize retry logic
  const retryOperation = async (operation, options = {}, retries = 3, baseDelay = 1000) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (!navigator.onLine) throw new Error('Offline');
        return await operation();
      } catch (err) {
        if (err.response?.status === 401 || attempt === retries) {
          throw err;
        }
        const delay = Math.pow(2, attempt - 1) * baseDelay; // Changed: Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  // Changed: Optimize fetchMyPosts with pagination
  const fetchMyPosts = useCallback(
    async (pageNum = 1, isRefresh = false) => {
      if (!token || !userId || (loading && !isRefresh) || (!hasMore && !isRefresh)) return;
      setLoading(true);
      try {
        const data = await retryOperation(() =>
          axios.get(`${BASE_URL}/social/my-posts/${userId}?page=${pageNum}&limit=9`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
          })
        );
        const posts = Array.isArray(data.posts) ? data.posts : [];
        setMyPosts((prev) => {
          const newPosts = isRefresh || pageNum === 1 ? posts : [...prev, ...posts];
          return Array.from(new Map(newPosts.map((p) => [p._id.toString(), p])).values()); // Changed: Deduplicate
        });
        setHasMore(data.hasMore || false);
        setError('');
      } catch (error) {
        setError(
          error.response?.status === 401
            ? 'Unauthorized. Please log in again.'
            : error.message === 'Offline'
            ? 'You are offline'
            : error.response?.data?.error || 'Failed to load posts'
        );
        if (error.response?.status === 401) setAuth('', '', '', '', '', '');
      } finally {
        setLoading(false);
      }
    },
    [token, userId, loading, hasMore, setAuth]
  );


  useEffect(() => {
    if (!token || !userId) {
      setError('Authentication required. Please log in again.');
      navigate('/login'); // Changed: Redirect to login
      return;
    }


    // Initialize socket with auth
    socket.emit('join', userId);
    fetchMyPosts();

    const handlePostDeleted = (postId) => {
      if (postId) {
        setMyPosts((prev) => prev.filter((p) => p._id.toString() !== postId.toString()));
      }
    };

    const handleOnlineStatus = ({ userId: updatedUserId, status, lastSeen }) => {
      if (updatedUserId === userId) {
        console.log(`User ${userId} is now ${status}, last seen: ${lastSeen}`);
      }
    };

    const handleConnectError = (err) => {
      console.warn('Socket connection error:', err.message);
      setError('Connection lost. Trying to reconnect...');
    };

    socket.on('postDeleted', handlePostDeleted);
    socket.on('onlineStatus', handleOnlineStatus);
    socket.on('connect_error', handleConnectError);

    // Changed: Apply dark mode
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('darkMode', darkMode);

    return () => {
      socket.off('postDeleted', handlePostDeleted);
      socket.off('onlineStatus', handleOnlineStatus);
      socket.off('connect_error', handleConnectError);
      socket.emit('leave', userId);
      if (photoPreview) URL.revokeObjectURL(photoPreview); // Changed: Cleanup memory
    };
  }, [token, userId, darkMode, fetchMyPosts, photoPreview]);

  // Changed: Optimize scroll for pagination
  useEffect(() => {
    const handleScroll = () => {
      if (!showPosts || loading || !hasMore) return;
      const container = document.querySelector('.posts-container');
      if (container && container.scrollTop + container.clientHeight >= container.scrollHeight - 100) {
        setPage((prev) => prev + 1);
        fetchMyPosts(page + 1);
      }
    };
    const container = document.querySelector('.posts-container');
    if (container) container.addEventListener('scroll', handleScroll);
    return () => container?.removeEventListener('scroll', handleScroll);
  }, [showPosts, loading, hasMore, page, fetchMyPosts]);

  const handlePhotoChange = useCallback((e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) { // Changed: 5MB limit
        setError('Photo must be under 5MB');
        return;
      }
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setPhotoFile(file);
      setPhotoPreview(URL.createObjectURL(file));
    }
  }, [photoPreview]);

  const uploadCV = async () => {
    if (!cvFile) {
      setError('Please select a CV file');
      return;
    }
    if (cvFile.size > 10 * 1024 * 1024) { // Changed: 10MB limit
      setError('CV must be under 10MB');
      return;
    }
    setLoading(true);
    const formData = new FormData();
    formData.append('cv_file', cvFile);
    formData.append('userId', userId);
    try {
      await retryOperation(() =>
        axios.post(`${BASE_URL}/jobseeker/update_cv`, formData, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
          timeout: 15000,
        })
      );
      setCvFile(null);
      setError('');
      alert('CV uploaded successfully');
    } catch (error) {
      setError(
        error.response?.status === 401
          ? 'Unauthorized. Please log in again.'
          : error.message === 'Offline'
          ? 'You are offline'
          : error.response?.data?.error || 'Failed to upload CV'
      );
      if (error.response?.status === 401) setAuth('', '', '', '', '', '');
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
      const data = await retryOperation(() =>
        axios.post(`${BASE_URL}/auth/update_photo`, formData, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
          timeout: 15000,
        })
      );
      setPhotoUrl(data.data.photo);
      localStorage.setItem('photo', data.data.photo);
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setPhotoFile(null);
      setPhotoPreview(null);
      setError('');
      alert('Photo uploaded successfully');
    } catch (error) {
      setError(
        error.response?.status === 401
          ? 'Unauthorized. Please log in again.'
          : error.message === 'Offline'
          ? 'You are offline'
          : error.response?.data?.error || 'Failed to upload photo'
      );
      if (error.response?.status === 401) setAuth('', '', '', '', '', '');
    } finally {
      setLoading(false);
    }
  };

  const updateUsername = async () => {
    if (!username.trim() || username.length > 30) { // Changed: Add length limit
      setError('Username must be non-empty and under 30 characters');
      return;
    }
    setLoading(true);
    try {
      const data = await retryOperation(() =>
        axios.post(`${BASE_URL}/auth/update_username`, { userId, username: username.trim() }, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        })
      );
      setUsername(data.data.username);
      localStorage.setItem('username', data.data.username);
      setEditUsername(false);
      setError('');
      alert('Username updated successfully');
    } catch (error) {
      setError(
        error.response?.status === 401
          ? 'Unauthorized. Please log in again.'
          : error.message === 'Offline'
          ? 'You are offline'
          : error.response?.data?.error || 'Failed to update username'
      );
      if (error.response?.status === 401) setAuth('', '', '', '', '', '');
    } finally {
      setLoading(false);
    }
  };

  const deletePost = async (postId) => {
    setLoading(true);
    try {
      await retryOperation(() =>
        axios.delete(`${BASE_URL}/social/post/${postId}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        })
      );
      socket.emit('postDeleted', postId);
      setShowDeleteConfirm(null);
      setSelectedPost(null);
      setError('');
    } catch (error) {
      setError(
        error.response?.status === 401
          ? 'Unauthorized. Please log in again.'
          : error.message === 'Offline'
          ? 'You are offline'
          : error.response?.data?.error || 'Failed to delete post'
      );
      if (error.response?.status === 401) setAuth('', '', '', '', '', '');
    } finally {
      setLoading(false);
    }
  };

  // ProfileScreen.js (only the relevant logout function is shown for brevity)
const logout = useCallback(async () => {
  try {
    await axios.post(
      `${BASE_URL}/auth/logout`, // Changed: Use /auth/logout instead of /social/logout
      {},
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      }
    );
    socket.emit('leave', userId);
    socket.disconnect();
    setAuth('', '', '', '', '', '');
    localStorage.clear();
    sessionStorage.clear(); // Changed: Clear sessionStorage
    navigate('/login'); // Changed: Explicitly navigate to login
  } catch (error) {
    console.error('Logout error:', error.message);
    setError('Failed to logout, please try again');
    if (error.response?.status === 401) {
      socket.emit('leave', userId);
      socket.disconnect();
      setAuth('', '', '', '', '', '');
      localStorage.clear();
      sessionStorage.clear();
      navigate('/login');
    }
  }
}, [userId, token, setAuth, navigate]);
  return (
    <motion.div
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen bg-gray-100 dark:bg-gray-900 p-6 flex items-center justify-center"
      role="main"
    >
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg max-w-md w-full">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-blue-600 dark:text-gray-100">Profile</h2>
          <div className="flex space-x-3">
            <motion.button
              whileHover={{ scale: 1.1 }}
              onClick={() => setDarkMode((prev) => !prev)}
              className="text-2xl text-blue-600 dark:text-gray-100 hover:text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {darkMode ? <FaSun /> : <FaMoon />}
            </motion.button>
            <button
              onClick={logout}
              className="text-2xl text-blue-600 dark:text-gray-100 hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-red-500"
              aria-label="Log out"
            >
              <FaSignOutAlt />
            </button>
          </div>
        </div>

        {error && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-red-500 mb-4 text-center"
            role="alert"
          >
            {error}
            {error.includes('Unauthorized') && (
              <button
                onClick={logout}
                className="ml-2 text-blue-500 underline focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="Log in again"
              >
                Log In
              </button>
            )}
          </motion.p>
        )}

        <div className="flex flex-col items-center mb-4">
          <img
            src={photoPreview || photoUrl}
            alt="Profile"
            className="w-24 h-24 rounded-full mb-4 object-cover"
            loading="lazy"
          />
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
                  onChange={(e) => setUsername(e.target.value.slice(0, 30))} // Changed: Limit length
                  className="flex-1 p-2 border rounded-lg dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-600"
                  placeholder="Enter unique username (max 30 chars)"
                  disabled={loading}
                  aria-label="Edit username"
                />
                <button
                  onClick={updateUsername}
                  className="ml-2 bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  disabled={loading}
                  aria-label="Save username"
                >
                  {loading ? 'Saving...' : 'Save'}
                </button>
              </>
            ) : (
              <span className="flex-1 text-gray-700 dark:text-gray-300">{username}</span>
            )}
            <button
              onClick={() => setEditUsername(!editUsername)}
              className="ml-2 text-xl text-blue-600 dark:text-gray-100 hover:text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
              aria-label={editUsername ? 'Cancel username edit' : 'Edit username'}
            >
              <FaEdit />
            </button>
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-gray-700 dark:text-gray-300 mb-2">Upload CV (PDF, max 10MB)</label>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setCvFile(e.target.files[0])}
            className="w-full p-3 border rounded-lg dark:bg-gray-700 dark:text-white"
            disabled={loading}
            aria-label="Upload CV"
          />
          <button
            onClick={uploadCV}
            className="mt-2 bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-800 w-full disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-600"
            disabled={!cvFile || loading}
            aria-label="Submit CV"
          >
            {loading ? 'Uploading...' : 'Upload CV'}
          </button>
        </div>

        <div className="mb-4">
          <label className="block text-gray-700 dark:text-gray-300 mb-2">Update Profile Photo (max 5MB)</label>
          <input
            type="file"
            accept="image/jpeg,image/png"
            onChange={handlePhotoChange}
            className="w-full p-3 border rounded-lg dark:bg-gray-700 dark:text-white"
            disabled={loading}
            aria-label="Upload profile photo"
          />
          <button
            onClick={uploadPhoto}
            className="mt-2 bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-800 w-full disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-600"
            disabled={!photoFile || loading}
            aria-label="Submit photo"
          >
            {loading ? 'Uploading...' : 'Update Photo'}
          </button>
        </div>

        <button
          onClick={() => {
            setShowPosts((prev) => !prev);
            if (!showPosts) fetchMyPosts(1, true); // Changed: Refresh posts
          }}
          className="bg-blue-600 text-white p-2 rounded-lg w-full hover:bg-blue-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-600"
          disabled={loading}
          aria-label={showPosts ? 'Hide my posts' : 'Show my posts'}
        >
          {loading ? 'Loading...' : showPosts ? 'Hide My Posts' : 'Show My Posts'}
        </button>

        <AnimatePresence>
          {showPosts && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-4 overflow-y-auto max-h-96 posts-container"
              role="region"
              aria-label="My posts"
            >
              {myPosts.length === 0 ? (
                <p className="text-gray-500 dark:text-gray-400 text-center">No posts yet</p>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {myPosts.map((post) => (
                    <div key={post._id.toString()} className="relative">
                      {post.contentType === 'image' && (
                        <img
                          src={post.content}
                          alt="Post"
                          className="w-full h-32 object-cover rounded"
                          loading="lazy"
                        />
                      )}
                      {post.contentType === 'video' && (
                        <video
                          src={post.content}
                          className="w-full h-32 object-cover rounded"
                          loading="lazy"
                          muted
                          preload="metadata" // Changed: Optimize video
                        />
                      )}
                      <button
                        onClick={() => setSelectedPost(selectedPost === post._id.toString() ? null : post._id.toString())}
                        className="absolute top-1 right-1 text-white bg-black bg-opacity-50 p-1 rounded hover:bg-opacity-75 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        aria-label="Post options"
                      >
                        <FaEllipsisH />
                      </button>
                      {selectedPost === post._id.toString() && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="absolute top-6 right-1 bg-white dark:bg-gray-800 p-2 rounded shadow-lg z-10"
                        >
                          <button
                            onClick={() => setShowDeleteConfirm(post._id.toString())}
                            className="flex items-center text-red-500 hover:text-red-700 dark:text-red-400 focus:outline-none focus:ring-2 focus:ring-red-500"
                            disabled={loading}
                            aria-label="Delete post"
                          >
                            <FaTrash className="mr-1" /> Delete
                          </button>
                        </motion.div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {hasMore && (
                <button
                  onClick={() => {
                    setPage((prev) => prev + 1);
                    fetchMyPosts(page + 1);
                  }}
                  className="mt-4 bg-blue-600 text-white p-2 rounded-lg w-full hover:bg-blue-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  disabled={loading}
                  aria-label="Load more posts"
                >
                  {loading ? 'Loading...' : 'Load More'}
                </button>
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
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-confirm"
          >
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg">
              <p id="delete-confirm" className="mb-4 text-black dark:text-gray-100">Are you sure you want to delete this post?</p>
              <div className="flex justify-end space-x-4">
                <button
                  onClick={() => setShowDeleteConfirm(null)}
                  className="bg-gray-300 dark:bg-gray-600 text-black dark:text-white p-2 rounded hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-500"
                  disabled={loading}
                  aria-label="Cancel delete"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deletePost(showDeleteConfirm)}
                  className="bg-red-500 text-white p-2 rounded hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
                  disabled={loading}
                  aria-label="Confirm delete"
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

export default ProfileScreen;