import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPlus, FaPaperPlane, FaHeart, FaComment, FaShare, FaVolumeMute, FaVolumeUp, FaSyncAlt, FaTextHeight, FaImage, FaVideo, FaMusic, FaFilm, FaUser } from 'react-icons/fa';
import { useSwipeable } from 'react-swipeable';
import debounce from 'lodash/debounce';
import PropTypes from 'prop-types';

const BASE_URL = 'https://gapp-6yc3.onrender.com';
const CACHE_KEY = 'feed_cache';
const CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes

const FeedScreen = ({ token, userId, socket, onLogout, theme }) => {
  const [posts, setPosts] = useState([]);
  const [contentType, setContentType] = useState('video');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [showPostModal, setShowPostModal] = useState(false);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [showComments, setShowComments] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [playingPostId, setPlayingPostId] = useState(null);
  const [muted, setMuted] = useState(localStorage.getItem('feedMuted') !== 'false');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [isAuthLoaded, setIsAuthLoaded] = useState(false);
  const [showUserPosts, setShowUserPosts] = useState(false); // New state for toggling user posts
  const feedRef = useRef(null);
  const mediaRefs = useRef({});
  const isFetchingFeedRef = useRef(false);
  const [likeAnimation, setLikeAnimation] = useState(null);

  const retryOperation = async (operation, maxRetries = 3, baseDelay = 1000) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!navigator.onLine) throw new Error('Offline');
        return await operation();
      } catch (err) {
        console.error(`Retry attempt ${attempt} failed:`, err.response?.data || err.message);
        if (err.response?.status === 401 || err.message === 'Unauthorized') {
          console.error('Authentication error: Attempting to refresh token...');
          setError('Session may be invalid. Attempting to refresh token...');
          const newToken = await refreshToken();
          if (newToken) {
            continue; // Retry with new token
          } else {
            setError('Authentication error, please try again later');
            return null;
          }
        }
        if (err.response?.status === 429) {
          setError(err.response.data.message || 'Too many requests, please try again later');
          return null;
        }
        if (attempt === maxRetries) throw err;
        const delay = Math.pow(2, attempt) * baseDelay;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  const refreshToken = async () => {
    try {
      const storedToken = localStorage.getItem('token');
      const storedUserId = localStorage.getItem('userId');
      if (!storedToken || !storedUserId) {
        throw new Error('Missing token or userId');
      }
      const response = await axios.post(
        `${BASE_URL}/auth/refresh`,
        { userId: storedUserId },
        {
          headers: { Authorization: `Bearer ${storedToken}` },
          timeout: 5000,
        }
      );
      const { token: newToken, userId: newUserId, role, virtualNumber, username, photo, privateKey } = response.data;
      localStorage.setItem('token', newToken);
      localStorage.setItem('userId', newUserId);
      localStorage.setItem('role', role || '0');
      localStorage.setItem('photo', photo || 'https://via.placeholder.com/64');
      localStorage.setItem('virtualNumber', virtualNumber || '');
      localStorage.setItem('username', username || '');
      localStorage.setItem('privateKey', privateKey || '');
      return newToken;
    } catch (error) {
      console.error('Token refresh failed:', error.message);
      return null;
    }
  };

  const loadFromCache = useCallback(() => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;
      const { posts, timestamp, page } = JSON.parse(cached);
      if (!posts || !Array.isArray(posts) || Date.now() - timestamp > CACHE_EXPIRY) {
        localStorage.removeItem(CACHE_KEY);
        return null;
      }
      return { posts, page };
    } catch (err) {
      console.error('Cache load error:', err.message);
      return null;
    }
  }, []);

  const saveToCache = useCallback((posts, page) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        posts,
        timestamp: Date.now(),
        page,
      }));
    } catch (err) {
      console.error('Cache save error:', err.message);
    }
  }, []);

  const setupIntersectionObserver = useCallback(
    () => {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const media = entry.target;
            const postId = media.dataset.postId;
            if (!postId) return;
            if (entry.isIntersecting && !showComments) {
              setPlayingPostId(postId);
              if (media.tagName === 'VIDEO' || media.tagName === 'AUDIO') {
                media.play().catch((err) => console.warn('Media play error:', err.message));
              }
            } else if (media.tagName === 'VIDEO' || media.tagName === 'AUDIO') {
              media.pause();
              media.currentTime = 0;
            }
          });
        },
        { threshold: 0.8 }
      );

      Object.values(mediaRefs.current).forEach((media) => {
        if (media) observer.observe(media);
      });

      return () => {
        observer.disconnect();
        Object.values(mediaRefs.current).forEach((media) => {
          if (media?.tagName === 'VIDEO' || media?.tagName === 'AUDIO') {
            media.pause();
            media.src = '';
            media.load();
          }
        });
        mediaRefs.current = {};
      };
    },
    [showComments]
  );

  const fetchFeed = useCallback(
    debounce(async (pageNum = 1, isRefresh = false) => {
      if (!token || !userId || isFetchingFeedRef.current || (!hasMore && !isRefresh)) return;
      isFetchingFeedRef.current = true;
      setLoading(true);
      if (isRefresh) setRefreshing(true);

      if (!isRefresh && pageNum === 1) {
        const cachedData = loadFromCache();
        if (cachedData) {
          setPosts(cachedData.posts);
          setPage(cachedData.page);
          setHasMore(true);
          setLoading(false);
          setRefreshing(false);
          isFetchingFeedRef.current = false;
          setPlayingPostId(cachedData.posts[0]?._id?.toString() || null);
          return;
        }
      }

      try {
        const url = showUserPosts
          ? `${BASE_URL}/feed/user/${userId}?page=${pageNum}&limit=10`
          : `${BASE_URL}/feed?page=${pageNum}&limit=10`;
        const { data } = await retryOperation(() =>
          axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
          })
        );
        const filteredPosts = Array.isArray(data.posts)
          ? data.posts.filter((post) => post?._id && !post.isStory)
          : [];
        setPosts((prev) => {
          const newPosts = pageNum === 1 || isRefresh ? filteredPosts : [...prev, ...filteredPosts];
          const uniquePosts = Array.from(
            new Map(newPosts.map((post) => [post._id.toString(), post])).values()
          );
          if (pageNum === 1 || isRefresh) saveToCache(uniquePosts, pageNum);
          return uniquePosts;
        });
        setHasMore(data.hasMore ?? false);
        setPage(pageNum);
        setError('');
        if (filteredPosts.length > 0 && (pageNum === 1 || isRefresh)) {
          setPlayingPostId(filteredPosts[0]?._id?.toString() || null);
        }
      } catch (error) {
        console.error('Fetch feed error:', error.message);
        setError(
          error.message === 'Offline'
            ? 'You are offline'
            : `Failed to load ${showUserPosts ? 'your posts' : 'feed'}`
        );
      } finally {
        isFetchingFeedRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }, 300),
    [token, userId, hasMore, loadFromCache, saveToCache, showUserPosts]
  );

  const getTokenExpiration = useCallback((token) => {
    try {
      if (!token || typeof token !== 'string' || !token.includes('.')) {
        console.warn('Invalid token format');
        return null;
      }
      const base64Url = token.split('.')[1];
      if (!base64Url) {
        console.warn('Invalid JWT payload');
        return null;
      }
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const decoded = JSON.parse(jsonPayload);
      if (!decoded.exp || isNaN(decoded.exp)) {
        console.warn('Invalid token expiration');
        return null;
      }
      return decoded.exp * 1000;
    } catch (error) {
      console.error('Error decoding token:', error.message);
      return null;
    }
  }, []);

  const socketPing = useCallback(() => {
    if (socket && socket.connected) {
      socket.emit('ping', { userId });
      socket.on('pong', () => {
        setSocketConnected(true);
        setError('');
      });
    }
  }, [socket, userId]);

  useEffect(() => {
    if (!token || !userId) {
      console.error('Missing token or userId');
      setError('Authentication required. Please log in again.');
      setIsAuthLoaded(true);
      return;
    }

    const expTime = getTokenExpiration(token);
    if (expTime && expTime < Date.now()) {
      console.warn('Token appears expired, attempting to refresh');
      refreshToken().then((newToken) => {
        if (!newToken) {
          setError('Authentication error, please try again later');
        }
        setIsAuthLoaded(true);
        fetchFeed(1);
      });
      return;
    }

    setIsAuthLoaded(true);
    fetchFeed(1);

    if (!socket) {
      console.warn('Socket not available, skipping socket setup');
      setError('Connecting to server...');
      return;
    }

    const socketTimeout = setTimeout(() => {
      if (!socket.connected) {
        console.warn('Socket not connected after delay');
        setError('Connecting to server...');
      } else {
        setSocketConnected(true);
        socket.emit('join', userId);
        socketPing();
      }
    }, 2000);

    const handleNewPost = (post) => {
      if (!post?.isStory && post?._id && (!showUserPosts || post.userId.toString() === userId)) {
        setPosts((prev) => {
          const newPosts = [post, ...prev];
          const uniquePosts = Array.from(new Map(newPosts.map((p) => [p._id.toString(), p])).values());
          saveToCache(uniquePosts, 1);
          return uniquePosts;
        });
        setCurrentIndex(0);
      }
    };

    const handlePostUpdate = (updatedPost) => {
      if (updatedPost?._id && (!showUserPosts || updatedPost.userId.toString() === userId)) {
        setPosts((prev) => {
          const newPosts = prev.map((p) => (p._id.toString() === updatedPost._id.toString() ? { ...p, ...updatedPost } : p));
          saveToCache(newPosts, page);
          return newPosts;
        });
      }
    };

    const handlePostDeleted = (postId) => {
      if (postId) {
        setPosts((prev) => {
          const newPosts = prev.filter((p) => p._id.toString() !== postId.toString());
          if (newPosts.length === 0) {
            setCurrentIndex(0);
            setPlayingPostId(null);
          } else if (currentIndex >= newPosts.length) {
            setCurrentIndex(newPosts.length - 1);
            setPlayingPostId(newPosts[newPosts.length - 1]?._id?.toString() || null);
          } else if (playingPostId === postId.toString()) {
            setPlayingPostId(newPosts[currentIndex]?._id?.toString() || null);
          }
          saveToCache(newPosts, page);
          return newPosts;
        });
      }
    };

    const handleConnectError = async (error) => {
      console.error('Socket connect error:', error.message);
      setSocketConnected(false);
      setError('Connection lost. Trying to reconnect...');
      if (error.message.includes('invalid token') || error.message.includes('No token provided')) {
        const newToken = await refreshToken();
        if (newToken) {
          socket.auth.token = newToken;
          socket.connect();
        } else {
          setError('Authentication error, please try again later');
        }
      }
    };

    const handleReconnect = () => {
      console.log('Socket reconnected');
      setSocketConnected(true);
      setError('');
      if (socket.connected) {
        socket.emit('join', userId);
        socketPing();
      }
    };

    socket.on('connect', () => {
      setSocketConnected(true);
      setError('');
      socket.emit('join', userId);
      socketPing();
    });
    socket.on('newPost', handleNewPost);
    socket.on('postUpdate', handlePostUpdate);
    socket.on('postDeleted', handlePostDeleted);
    socket.on('connect_error', handleConnectError);
    socket.on('reconnect', handleReconnect);

    return () => {
      clearTimeout(socketTimeout);
      socket.off('connect');
      socket.off('newPost', handleNewPost);
      socket.off('postUpdate', handlePostUpdate);
      socket.off('postDeleted', handlePostDeleted);
      socket.off('connect_error', handleConnectError);
      socket.off('reconnect', handleReconnect);
      socket.off('pong');
      if (socket.connected) {
        socket.emit('leave', userId);
      }
    };
  }, [token, userId, socket, fetchFeed, socketPing, page, saveToCache, showUserPosts]);

  useEffect(() => {
    localStorage.setItem('feedMuted', muted);
  }, [muted]);

  const handleScroll = useCallback(
    debounce(() => {
      if (!feedRef.current || isFetchingFeedRef.current || !hasMore) return;
      const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
      if (scrollTop + clientHeight >= scrollHeight - 100) {
        const nextPage = page + 1;
        setPage(nextPage);
        fetchFeed(nextPage);
      }
    }, 200),
    [hasMore, page, fetchFeed]
  );

  useEffect(() => {
    const cleanup = setupIntersectionObserver();
    const feedElement = feedRef.current;
    if (feedElement) {
      feedElement.addEventListener('scroll', handleScroll);
      if (posts.length > 0 && currentIndex < posts.length) {
        feedElement.scrollTo({ top: currentIndex * (window.innerHeight - 80), behavior: 'smooth' });
      }
    }
    return () => {
      if (feedElement) feedElement.removeEventListener('scroll', handleScroll);
      cleanup();
    };
  }, [posts, currentIndex, setupIntersectionObserver, handleScroll]);

  const postContent = async () => {
    if (!userId || !token) {
      setError('Authentication required. Please log in again.');
      return;
    }
    if (!caption.trim() && !file && contentType !== 'text') {
      setError('Please provide a caption or file');
      return;
    }
    if ((contentType === 'image' || contentType === 'video' || contentType === 'video+audio') && !file) {
      setError('Please select a file');
      return;
    }
    if (contentType === 'video+audio' && !audioFile) {
      setError('Please select an audio file for video+audio post');
      return;
    }

    const formData = new FormData();
    formData.append('userId', userId);
    formData.append('contentType', contentType);
    formData.append('caption', caption.trim());
    if (file) formData.append('content', file);
    if (contentType === 'text') formData.append('content', caption.trim());
    if (contentType === 'video+audio' && audioFile) formData.append('audio', audioFile);

    try {
      setUploadProgress(0);
      const { data } = await retryOperation(() =>
        axios.post(`${BASE_URL}/feed`, formData, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'multipart/form-data',
          },
          onUploadProgress: (progressEvent) =>
            setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total)),
          timeout: 15000,
        })
      );
      socket.emit('newPost', data);
      setCaption('');
      setFile(null);
      setAudioFile(null);
      setShowPostModal(false);
      setUploadProgress(null);
      setError('');
      setCurrentIndex(0);
    } catch (error) {
      console.error('Post error:', error.message);
      setError(
        error.message === 'Offline'
          ? 'You are offline'
          : 'Failed to post content'
      );
      setUploadProgress(null);
    }
  };

  const likePost = async (postId) => {
    if (!playingPostId || postId !== playingPostId) return;
    try {
      const post = posts.find((p) => p._id.toString() === postId);
      if (!post) throw new Error('Post not found');
      const action = post.likedBy?.map((id) => id.toString()).includes(userId) ? '/unlike' : '/like';
      const { data } = await retryOperation(() =>
        axios.post(
          `${BASE_URL}/feed${action}`,
          { postId, userId },
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
          }
        )
      );
      socket.emit('postUpdate', data);
      setLikeAnimation(postId);
      setTimeout(() => setLikeAnimation(null), 1000);
    } catch (error) {
      console.error('Like error:', error.message);
      setError(
        error.message === 'Offline'
          ? 'You are offline'
          : 'Failed to like post'
      );
    }
  };

  const commentPost = async (postId) => {
    if (!playingPostId || postId !== playingPostId || !comment.trim()) return;
    try {
      const { data } = await retryOperation(() =>
        axios.post(
          `${BASE_URL}/feed/comment`,
          { postId, comment: comment.trim(), userId },
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
          }
        )
      );
      socket.emit('postUpdate', {
        ...posts.find((p) => p._id.toString() === postId),
        comments: [...(posts.find((p) => p._id.toString() === postId)?.comments || []), data],
      });
      setComment('');
      setShowComments(null);
    } catch (error) {
      console.error('Comment error:', error.message);
      setError(
        error.message === 'Offline'
          ? 'You are offline'
          : 'Failed to comment'
      );
    }
  };

  const timeAgo = useCallback((date) => {
    if (!date) return 'Unknown';
    const now = new Date();
    const diff = now - new Date(date);
    const minutes = Math.floor(diff / 60000);
    if (isNaN(minutes)) return 'Invalid date';
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }, []);

  const handleRefresh = useCallback(() => {
    setPage(1);
    setCurrentIndex(0);
    setHasMore(true);
    fetchFeed(1, true);
  }, [fetchFeed]);

  const handleToggleUserPosts = useCallback(() => {
    setShowUserPosts((prev) => !prev);
    setPage(1);
    setCurrentIndex(0);
    setHasMore(true);
    setPosts([]);
    fetchFeed(1, true);
  }, [fetchFeed]);

  const swipeHandlers = useSwipeable({
    onSwipedUp: () => {
      if (showComments) return;
      setCurrentIndex((prev) => Math.min(prev + 1, posts.length - 1));
    },
    onSwipedDown: () => {
      if (showComments) return;
      if (currentIndex === 0) {
        handleRefresh();
      } else {
        setCurrentIndex((prev) => Math.max(prev - 1, 0));
      }
    },
    onSwipedLeft: () => {
      if (showComments) setShowComments(null);
    },
    onSwipedRight: () => {
      if (!showComments && playingPostId) setShowComments(playingPostId);
    },
    trackMouse: false,
    delta: 30,
    preventScrollOnSwipe: true,
  });

  const handleDoubleTap = useCallback(
    (postId) => {
      likePost(postId);
    },
    [likePost]
  );

  const LoadingSkeleton = () => (
    <div className="h-[calc(100vh-80px)] w-full bg-gray-200 dark:bg-gray-700 animate-pulse relative snap-start md:max-w-[600px] md:h-[800px] md:rounded-lg">
      <div className="absolute top-4 left-4 flex items-center">
        <div className="w-10 h-10 rounded-full bg-gray-300 dark:bg-gray-600"></div>
        <div className="ml-2">
          <div className="w-20 h-4 bg-gray-300 dark:bg-gray-600 rounded"></div>
          <div className="w-10 h-3 mt-1 bg-gray-300 dark:bg-gray-600 rounded"></div>
        </div>
      </div>
      <div className="w-full h-full bg-gray-300 dark:bg-gray-600"></div>
      <div className="absolute right-4 bottom-4 flex flex-col space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="w-8 h-8 bg-gray-300 dark:bg-gray-600 rounded-full"></div>
        ))}
      </div>
    </div>
  );

  return (
    <motion.div
      ref={feedRef}
      {...swipeHandlers}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className={`max-h-[calc(100vh-80px)] overflow-y-auto bg-gray-100 dark:bg-gray-900 snap-y snap-mandatory md:max-w-[600px] md:mx-auto md:rounded-lg md:shadow-lg overscroll-y-contain ${theme === 'dark' ? 'dark' : ''}`}
      style={{ scrollSnapType: 'y mandatory', overscrollBehaviorY: 'contain' }}
    >
      {!isAuthLoaded && (
        <div className="h-[calc(100vh-80px)] flex items-center justify-center text-gray-700 dark:text-gray-300">
          <p>Loading authentication...</p>
        </div>
      )}
      {error && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-500 text-white p-4 rounded-lg shadow-lg z-50 max-w-md w-full">
          <p className="text-sm">{error}</p>
          <button
            className="bg-white text-red-500 px-3 py-1 mt-2 rounded hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-white"
            onClick={() => setError('')}
            aria-label="Dismiss error"
          >
            OK
          </button>
        </div>
      )}
      <div className="fixed top-4 right-4 z-20">
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={handleToggleUserPosts}
          className={`p-3 rounded-full shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            showUserPosts ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white' : 'bg-gray-200 dark:bg-gray-600 text-gray-900 dark:text-gray-100'
          }`}
          aria-label={showUserPosts ? 'Show all posts' : 'Show my posts'}
          title={showUserPosts ? 'Show all posts' : 'Show my posts'}
        >
          <FaUser className="text-xl" />
        </motion.button>
      </div>
      <div className="fixed bottom-20 right-4 z-20">
        <motion.button
          whileHover={{ scale: 1.1, rotate: 90 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => setShowPostModal(true)}
          className="bg-gradient-to-r from-blue-500 to-purple-600 text-white p-4 rounded-full shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="Create new post"
        >
          <FaPlus className="text-xl" />
        </motion.button>
      </div>

      <AnimatePresence>
        {showPostModal && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-30 px-4"
            role="dialog"
            aria-modal="true"
          >
            <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 p-6 rounded-2xl shadow-2xl w-full max-w-md relative border border-gray-200 dark:border-gray-700">
              {uploadProgress !== null && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-75">
                  <div className="relative w-20 h-20">
                    <svg className="w-full h-full" viewBox="0 0 36 36">
                      <path
                        className="text-gray-300 dark:text-gray-700"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                      />
                      <path
                        className="text-blue-500"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeDasharray={`${uploadProgress}, 100`}
                      />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center text-blue-500 font-bold">
                      {uploadProgress}%
                    </span>
                  </div>
                </div>
              )}
              <div className="relative mb-4">
                <div className="flex justify-around mb-4 bg-gray-100 dark:bg-gray-700 p-2 rounded-lg">
                  {[
                    { type: 'text', icon: <FaTextHeight /> },
                    { type: 'image', icon: <FaImage /> },
                    { type: 'video', icon: <FaVideo /> },
                    { type: 'audio', icon: <FaMusic /> },
                    { type: 'video+audio', icon: <FaFilm /> },
                  ].map(({ type, icon }) => (
                    <motion.button
                      key={type}
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={() => setContentType(type)}
                      className={`p-2 rounded-full ${contentType === type ? 'bg-blue-500 text-white' : 'bg-gray-200 dark:bg-gray-600 text-gray-900 dark:text-gray-100'}`}
                      aria-label={`Select ${type} content`}
                    >
                      {icon}
                    </motion.button>
                  ))}
                </div>
                <div className="flex flex-col space-y-4">
                  {contentType === 'text' ? (
                    <textarea
                      value={caption}
                      onChange={(e) => setCaption(e.target.value.slice(0, 500))}
                      className="flex-1 p-3 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none transition duration-200 resize-none"
                      placeholder="What's on your mind? (max 500 chars)"
                      rows="4"
                      aria-label="Text post content"
                    />
                  ) : (
                    <input
                      type="file"
                      accept={
                        contentType === 'image'
                          ? 'image/jpeg,image/png'
                          : contentType === 'video' || contentType === 'video+audio'
                          ? 'video/mp4,video/webm'
                          : 'audio/mpeg,audio/wav'
                      }
                      onChange={(e) => setFile(e.target.files[0])}
                      className="flex-1 p-3 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-gray-100 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-blue-500 file:text-white file:cursor-pointer"
                      aria-label="Upload main file"
                    />
                  )}
                  {contentType === 'video+audio' && (
                    <input
                      type="file"
                      accept="audio/mpeg,audio/wav"
                      onChange={(e) => setAudioFile(e.target.files[0])}
                      className="flex-1 p-3 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-gray-100 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-blue-500 file:text-white file:cursor-pointer"
                      aria-label="Upload audio file"
                    />
                  )}
                  {contentType !== 'text' && (
                    <input
                      type="text"
                      value={caption}
                      onChange={(e) => setCaption(e.target.value.slice(0, 500))}
                      className="w-full p-3 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none transition duration-200"
                      placeholder="Add a caption... (max 500 chars)"
                      aria-label="Post caption"
                    />
                  )}
                  <motion.button
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={postContent}
                    className="p-3 bg-blue-500 rounded-full text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    aria-label="Submit post"
                  >
                    <FaPaperPlane className="text-xl" />
                  </motion.button>
                </div>
              </div>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => {
                  setShowPostModal(false);
                  setCaption('');
                  setFile(null);
                  setAudioFile(null);
                  setError('');
                }}
                className="mt-4 w-full bg-gray-300 dark:bg-gray-600 text-gray-900 dark:text-gray-100 p-3 rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500 transition duration-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                aria-label="Cancel post"
              >
                Cancel
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {refreshing && (
        <div className="fixed top-4 left-0 right-0 text-center text-gray-900 dark:text-gray-100 z-10">
          <FaSyncAlt className="inline-block w-6 h-6 animate-spin text-blue-500" aria-label="Refreshing feed" />
        </div>
      )}

      {loading && !refreshing && (
        <div className="fixed bottom-20 left-0 right-0 text-center text-gray-900 dark:text-gray-100">
          <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" aria-label="Loading more posts"></div>
        </div>
      )}

      {posts.length === 0 && !loading && !refreshing ? (
        <div className="h-[calc(100vh-80px)] flex items-center justify-center text-center text-gray-700 dark:text-gray-300" role="status">
          <p className="text-lg">{showUserPosts ? 'You have no posts yet' : 'No posts available'}</p>
        </div>
      ) : posts.length === 0 && loading ? (
        [...Array(3)].map((_, i) => <LoadingSkeleton key={i} />)
      ) : (
        posts.map((post, index) => (
          <motion.div
            key={post._id.toString()}
            initial={{ opacity: 0 }}
            animate={{ opacity: index === currentIndex ? 1 : 0.5 }}
            transition={{ duration: 0.3 }}
            className="h-[calc(100vh-80px)] w-full flex flex-col items-center justify-center text-gray-900 dark:text-gray-100 relative snap-start md:max-w-[600px] md:h-[800px] md:rounded-lg md:shadow-lg md:bg-gray-100 dark:md:bg-gray-900 px-4"
            onDoubleClick={() => handleDoubleTap(post._id.toString())}
            role="article"
            aria-labelledby={`post-${post._id}`}
            style={{ scrollSnapAlign: 'start' }}
          >
            <div className="absolute top-4 left-4 z-10 flex items-center">
              <img
                src={post.photo || 'https://placehold.co/40x40'}
                alt={`${post.username || 'Unknown'}'s profile`}
                className="w-10 h-10 rounded-full mr-2 border-2 border-blue-500"
                onError={(e) => (e.target.src = 'https://placehold.co/40x40')}
              />
              <div>
                <span id={`post-${post._id}`} className="font-bold text-gray-900 dark:text-gray-100">{post.username || 'Guest'}</span>
                <span className="text-xs ml-1 text-gray-500 dark:text-gray-400">{timeAgo(post.createdAt)}</span>
              </div>
            </div>

            {post.contentType === 'text' && (
              <p className="text-lg p-4 bg-white dark:bg-gray-800 bg-opacity-50 rounded-lg max-w-[80%] mx-auto text-center dark:text-gray-100">
                {post.content || 'No content available.'}
              </p>
            )}
            {post.contentType === 'image' && (
              <img
                src={post.content}
                alt="Post image"
                className="w-full max-h-[calc(100vh-200px)] object-contain rounded-md"
                data-post-id={post._id.toString()}
                ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
                onError={(e) => (e.target.src = 'https://placehold.co/600x400?text=Image+Error')}
                preload="auto"
              />
            )}
            {post.contentType === 'video' && (
              <div className="relative w-full max-h-[calc(100vh-200px)]">
                <video
                  ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
                  data-post-id={post._id.toString()}
                  playsInline
                  muted={muted}
                  loop
                  src={post.content}
                  className="w-full max-h-[calc(100vh-200px)] object-contain rounded-md"
                  preload="auto"
                  poster="https://placehold.co/600x400?text=Video+Loading"
                  onError={() => console.warn('Video load error')}
                />
                {post.audioContent && (
                  <motion.div
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="absolute bottom-4 right-4 flex items-center space-x-2 text-white bg-black bg-opacity-50 p-2 rounded-full"
                  >
                    <FaMusic className="text-lg" />
                    <span className="text-sm">Audio Playing</span>
                  </motion.div>
                )}
              </div>
            )}
            {post.contentType === 'video+audio' && (
              <div className="relative w-full max-h-[calc(100vh-200px)]">
                <video
                  ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
                  data-post-id={post._id.toString()}
                  playsInline
                  muted={muted}
                  loop
                  src={post.content}
                  className="w-full max-h-[calc(100vh-200px)] object-contain rounded-md"
                  preload="auto"
                  poster="https://placehold.co/600x400?text=Video+Loading"
                  onError={() => console.warn('Video load error')}
                />
                <audio
                  ref={(el) => (mediaRefs.current[`audio-${post._id.toString()}`] = el)}
                  data-post-id={post._id.toString()}
                  src={post.audioContent}
                  loop
                  muted={muted}
                  preload="auto"
                  onError={() => console.warn('Audio load error')}
                />
                <motion.div
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ repeat: Infinity, duration: 1.5 }}
                  className="absolute bottom-4 right-4 flex items-center space-x-2 text-white bg-black bg-opacity-50 p-2 rounded-full"
                >
                  <FaMusic className="text-lg" />
                  <span className="text-sm">Audio Playing</span>
                </motion.div>
              </div>
            )}
            {post.contentType === 'audio' && (
              <div className="relative w-full max-h-[calc(100vh-200px)] flex items-center justify-center">
                <audio
                  ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
                  data-post-id={post._id.toString()}
                  controls
                  src={post.content}
                  className="w-full max-w-[80%] mt-2 bg-gray-300 dark:bg-gray-700 rounded-full p-2"
                  preload="auto"
                  onError={() => console.warn('Audio load error')}
                />
                <motion.div
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ repeat: Infinity, duration: 1.5 }}
                  className="absolute bottom-4 right-4 flex items-center space-x-2 text-white bg-black bg-opacity-50 p-2 rounded-full"
                >
                  <FaMusic className="text-lg" />
                  <span className="text-sm">Audio Playing</span>
                </motion.div>
              </div>
            )}
            {post.contentType === 'raw' && (
              <a
                href={post.content}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 p-4 bg-gray-200 dark:bg-gray-800 bg-opacity-50 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900"
                aria-label="Open document"
              >
                Open Document
              </a>
            )}

            <AnimatePresence>
              {likeAnimation === post._id.toString() && (
                <motion.div
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 2, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  transition={{ duration: 0.5 }}
                  className="absolute inset-0 flex items-center justify-center"
                >
                  <FaHeart className="text-red-500 text-6xl" />
                </motion.div>
              )}
            </AnimatePresence>

            <div className="absolute right-4 bottom-4 flex flex-col items-center space-y-6 z-10">
              <div className="motion-button">
                <button
                  onClick={() => likePost(post._id.toString())}
                  className="flex flex-col items-center focus:outline-none focus:ring-2 focus:ring-red-400"
                  aria-label={post.likedBy?.map((id) => id.toString()).includes(userId) ? 'Unlike post' : 'Like post'}
                >
                  <FaHeart
                    className={`text-3xl ${post.likedBy?.map((id) => id.toString()).includes(userId) ? 'text-red-500' : 'text-gray-900 dark:text-gray-100'}`}
                  />
                  <span className="text-sm text-gray-900 dark:text-gray-100">{post.likes || 0}</span>
                </button>
              </div>
              <div className="motion-button">
                <button
                  onClick={() => setShowComments(post._id.toString())}
                  className="flex flex-col items-center focus:outline-none focus:ring-2 focus:ring-blue-400"
                  aria-label="View comments"
                >
                  <FaComment className="text-3xl text-gray-900 dark:text-gray-100 hover:text-blue-500" />
                  <span className="text-sm text-gray-900 dark:text-gray-100">{post.comments?.length || 0}</span>
                </button>
              </div>
              <div className="motion-button">
                <button
                  onClick={() =>
                    navigator.clipboard
                      .writeText(`${window.location.origin}/post/${post._id.toString()}`)
                      .then(() => alert('Link copied!'))
                      .catch(() => setError('Failed to copy link'))
                  }
                  className="flex flex-col items-center focus:outline-none focus:ring-2 focus:ring-blue-400"
                  aria-label="Share post"
                >
                  <FaShare className="text-3xl text-gray-900 dark:text-gray-100 hover:text-blue-500" />
                </button>
              </div>
              {(post.contentType === 'video' || post.contentType === 'video+audio') && (
                <div className="motion-button">
                  <button
                    onClick={() => setMuted((prev) => !prev)}
                    className="flex flex-col items-center focus:outline-none focus:ring-2 focus:ring-blue-400"
                    aria-label={muted ? 'Unmute video' : 'Mute video'}
                  >
                    {muted ? (
                      <FaVolumeMute className="text-3xl text-gray-900 dark:text-gray-100 hover:text-blue-500" />
                    ) : (
                      <FaVolumeUp className="text-3xl text-gray-900 dark:text-gray-100 hover:text-blue-500" />
                    )}
                  </button>
                </div>
              )}
            </div>

            {post.caption && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute bottom-4 left-4 right-4 text-sm bg-white dark:bg-gray-800 bg-opacity-50 p-3 rounded-lg max-w-[70%] md:max-w-[80%]"
              >
                <span className="font-bold text-gray-900 dark:text-gray-100">{post.username || 'Guest'}</span>
                <span className="ml-1 text-gray-700 dark:text-gray-300">{post.caption}</span>
              </motion.div>
            )}

            <AnimatePresence>
              {showComments === post._id.toString() && (
                <motion.div
                  initial={{ opacity: 0, y: 100 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 100 }}
                  className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 p-4 rounded-t-lg shadow-lg max-h-[calc(50vh-80px)] overflow-y-auto z-10 md:max-w-[600px] md:mx-auto"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby={`comments-${post._id}`}
                >
                  <h3 id={`comments-${post._id}`} className="text-lg font-bold text-blue-600 dark:text-blue-400 mb-2">Comments</h3>
                  {post.comments?.length === 0 ? (
                    <p className="text-gray-500 dark:text-gray-400">No comments yet</p>
                  ) : (
                    post.comments.map((c, i) => (
                      <div key={`${c.createdAt}-${i}`} className="flex items-center mb-2">
                        <img
                          src={c.photo || 'https://placehold.co/30x30'}
                          alt={`${c.username || 'Guest'}'s profile picture`}
                          className="w-8 h-8 rounded-full mr-2 border border-gray-300 dark:border-gray-600"
                          onError={(e) => (e.target.src = 'https://placehold.co/30x30')}
                        />
                        <p className="text-sm text-gray-700 dark:text-gray-300">
                          <span className="font-semibold text-gray-900 dark:text-gray-100">{c.username || 'Guest'}</span>
                          <span className="ml-2">{c.comment}</span>
                        </p>
                      </div>
                    ))
                  )}
                  <div className="flex items-center mt-3">
                    <input
                      type="text"
                      value={comment}
                      onChange={(e) => setComment(e.target.value.slice(0, 255))}
                      className="flex-1 p-2 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-full text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                      placeholder="Add a comment... (max 255 chars)"
                      aria-label="Add comment"
                    />
                    <motion.button
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={() => commentPost(post._id.toString())}
                      className="ml-2 p-3 bg-blue-500 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500"
                      aria-label="Submit comment"
                    >
                      <FaPaperPlane className="text-xl text-white" />
                    </motion.button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        ))
      )}

      {showComments && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-0"
          onClick={() => setShowComments(null)}
          aria-hidden="true"
        />
      )}
    </motion.div>
  );
};

FeedScreen.propTypes = {
  token: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  socket: PropTypes.object.isRequired,
  onLogout: PropTypes.func.isRequired,
  theme: PropTypes.string,
};

export default FeedScreen;