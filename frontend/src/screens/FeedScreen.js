import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPlus, FaPaperPlane, FaHeart, FaComment, FaShare, FaVolumeMute, FaVolumeUp, FaSyncAlt } from 'react-icons/fa';
import { useSwipeable } from 'react-swipeable';
import debounce from 'lodash/debounce';
import PropTypes from 'prop-types';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const FeedScreen = ({ token, userId, socket, onLogout, theme }) => {
  const [posts, setPosts] = useState([]);
  const [contentType, setContentType] = useState('video');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState(null);
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
  const feedRef = useRef(null);
  const mediaRefs = useRef({});
  const isFetchingFeedRef = useRef(false);

  const retryOperation = async (operation, maxRetries = 3, baseDelay = 1000) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!navigator.onLine) throw new Error('Offline');
        return await operation();
      } catch (err) {
        console.error(`Retry attempt ${attempt} failed:`, err.response?.data || err.message);
        if (err.response?.status === 401 || err.message === 'Unauthorized') {
          setError('Unauthorized. Please log in again.');
          onLogout();
          throw new Error('Unauthorized');
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
              if (media.tagName === 'VIDEO') {
                media.play().catch((err) => console.warn('Video play error:', err.message));
              }
            } else if (media.tagName === 'VIDEO') {
              media.pause();
              media.currentTime = 0;
            }
          });
        },
        { threshold: 0.6 }
      );

      Object.values(mediaRefs.current).forEach((media) => {
        if (media) observer.observe(media);
      });

      return () => {
        observer.disconnect();
        Object.values(mediaRefs.current).forEach((media) => {
          if (media?.tagName === 'VIDEO') {
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

      try {
        const { data } = await retryOperation(() =>
          axios.get(`${BASE_URL}/social/feed?page=${pageNum}&limit=10`, {
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
            : error.message === 'Unauthorized'
            ? 'Unauthorized. Please log in again.'
            : 'Failed to load feed'
        );
      } finally {
        isFetchingFeedRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }, 300),
    [token, userId, hasMore, onLogout]
  );

  useEffect(() => {
    if (!token || !userId || !socket) {
      onLogout();
      return;
    }

    fetchFeed(1);
    socket.emit('join', userId);

    const handleNewPost = (post) => {
      if (!post?.isStory && post?._id) {
        setPosts((prev) => {
          const newPosts = [post, ...prev];
          return Array.from(new Map(newPosts.map((p) => [p._id.toString(), p])).values());
        });
        setCurrentIndex(0);
      }
    };

    const handlePostUpdate = (updatedPost) => {
      if (updatedPost?._id) {
        setPosts((prev) =>
          prev.map((p) => (p._id.toString() === updatedPost._id.toString() ? { ...p, ...updatedPost } : p))
        );
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
          return newPosts;
        });
      }
    };

    const handleConnectError = (error) => {
      console.error('Socket connect error:', error.message);
      setError('Connection lost. Trying to reconnect...');
      if (error.message.includes('invalid token')) {
        setError('Session expired. Please log in again.');
        onLogout();
      }
    };

    const handleReconnect = () => {
      console.log('Socket reconnected');
      setError('');
      socket.emit('join', userId);
    };

    socket.on('newPost', handleNewPost);
    socket.on('postUpdate', handlePostUpdate);
    socket.on('postDeleted', handlePostDeleted);
    socket.on('connect_error', handleConnectError);
    socket.on('reconnect', handleReconnect);

    return () => {
      socket.off('newPost', handleNewPost);
      socket.off('postUpdate', handlePostUpdate);
      socket.off('postDeleted', handlePostDeleted);
      socket.off('connect_error', handleConnectError);
      socket.off('reconnect', handleReconnect);
      socket.emit('leave', userId);
    };
  }, [token, userId, socket, currentIndex, playingPostId, onLogout, fetchFeed]);

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
        feedElement.scrollTo({ top: currentIndex * window.innerHeight, behavior: 'smooth' });
      }
    }
    return () => {
      if (feedElement) feedElement.removeEventListener('scroll', handleScroll);
      cleanup();
    };
  }, [posts, currentIndex, setupIntersectionObserver, handleScroll]);

  const postContent = async () => {
    if (!userId || (!caption.trim() && !file && contentType !== 'text')) {
      setError('Please provide content');
      return;
    }
    const formData = new FormData();
    formData.append('userId', userId);
    formData.append('contentType', contentType);
    formData.append('caption', caption.trim());
    if (file) formData.append('content', file);
    else if (contentType === 'text') formData.append('content', caption.trim());

    try {
      setUploadProgress(0);
      const { data } = await retryOperation(() =>
        axios.post(`${BASE_URL}/social/post`, formData, {
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
      setShowPostModal(false);
      setUploadProgress(null);
      setError('');
      setCurrentIndex(0);
    } catch (error) {
      console.error('Post error:', error.message);
      setError(
        error.message === 'Offline'
          ? 'You are offline'
          : error.message === 'Unauthorized'
          ? 'Unauthorized. Please log in again.'
          : error.response?.data?.error || 'Failed to post'
      );
      setUploadProgress(null);
    }
  };

  const likePost = async (postId) => {
    if (!playingPostId || postId !== playingPostId) return;
    try {
      const post = posts.find((p) => p._id.toString() === postId);
      if (!post) return;
      const action = post.likedBy?.map((id) => id.toString()).includes(userId) ? '/unlike' : '/like';
      const { data } = await retryOperation(() =>
        axios.post(
          `${BASE_URL}/social/post${action}`,
          { postId, userId },
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
          }
        )
      );
      socket.emit('postUpdate', data);
    } catch (error) {
      console.error('Like error:', error.message);
      setError(
        error.message === 'Offline'
          ? 'You are offline'
          : error.message === 'Unauthorized'
          ? 'Unauthorized. Please log in again.'
          : 'Failed to like post'
      );
    }
  };

  const commentPost = async (postId) => {
    if (!playingPostId || postId !== playingPostId || !comment.trim()) return;
    try {
      const { data } = await retryOperation(() =>
        axios.post(
          `${BASE_URL}/social/post/comment`,
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
          : error.message === 'Unauthorized'
          ? 'Unauthorized. Please log in again.'
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
    delta: 50,
    preventScrollOnSwipe: true,
  });

  const handleDoubleTap = useCallback(
    (postId) => {
      likePost(postId);
    },
    [likePost]
  );

  const LoadingSkeleton = () => (
    <div className="h-screen w-full bg-gray-200 dark:bg-gray-700 animate-pulse relative snap-start md:max-w-[600px] md:h-[800px] md:rounded-lg">
      <div className="absolute top-4 left-4 flex items-center">
        <div className="w-10 h-10 rounded-full bg-gray-300 dark:bg-gray-600"></div>
        <div className="ml-2">
          <div className="w-20 h-4 bg-gray-300 dark:bg-gray-600 rounded"></div>
          <div className="w-10 h-3 mt-1 bg-gray-300 dark:bg-gray-600 rounded"></div>
        </div>
      </div>
      <div className="w-full h-full bg-gray-300 dark:bg-gray-600"></div>
      <div className="absolute right-4 bottom-20 flex flex-col space-y-4">
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
      className={`h-screen overflow-y-auto bg-gray-100 dark:bg-gray-900 snap-y snap-mandatory md:max-w-[600px] md:mx-auto md:rounded-lg md:shadow-lg ${theme === 'dark' ? 'dark' : ''}`}
    >
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
            <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 p-6 rounded-2xl shadow-2xl w-full max-w-md relative">
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
                <select
                  value={contentType}
                  onChange={(e) => setContentType(e.target.value)}
                  className="w-full p-3 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none transition duration-200"
                  aria-label="Select content type"
                >
                  <option value="text">Text</option>
                  <option value="image">Image</option>
                  <option value="video">Video</option>
                  <option value="audio">Audio</option>
                  <option value="raw">Document</option>
                </select>
              </div>
              <div className="flex items-center mb-4">
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
                        : contentType === 'video'
                        ? 'video/mp4,video/webm'
                        : contentType === 'audio'
                        ? 'audio/mpeg,audio/wav'
                        : 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    }
                    onChange={(e) => setFile(e.target.files[0])}
                    className="flex-1 p-3 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-gray-100 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-blue-500 file:text-white file:cursor-pointer"
                    aria-label="Upload file"
                  />
                )}
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={postContent}
                  className="ml-3 p-3 bg-blue-500 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label="Submit post"
                >
                  <FaPaperPlane className="text-xl text-white" />
                </motion.button>
              </div>
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
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => {
                  setShowPostModal(false);
                  setCaption('');
                  setFile(null);
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

      {error && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="text-red-500 text-center py-3 z-10 fixed top-0 w-full bg-gray-100 dark:bg-gray-900 bg-opacity-75 md:max-w-[600px] md:mx-auto"
          role="alert"
        >
          {error}
          {error.includes('Unauthorized') && (
            <button
              onClick={onLogout}
              className="ml-2 text-blue-500 underline focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Log in"
            >
              Log In
            </button>
          )}
        </motion.div>
      )}

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
        <div className="h-screen flex items-center justify-center text-center text-gray-700 dark:text-gray-300" role="status">
          <p className="text-lg">No posts available</p>
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
            className="h-screen w-full flex flex-col items-center justify-center text-gray-900 dark:text-gray-100 relative snap-start md:max-w-[600px] md:mx-auto md:h-[800px] md:rounded-lg md:shadow-lg md:bg-gray-100 dark:md:bg-gray-900"
            onDoubleClick={() => handleDoubleTap(post._id.toString())}
            role="article"
            aria-labelledby={`post-${post._id}`}
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
                className="w-full h-full object-cover rounded-md"
                data-post-id={post._id.toString()}
                ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
                onError={(e) => (e.target.src = 'https://placehold.co/600x400?text=Image+Error')}
              />
            )}
            {post.contentType === 'video' && (
              <video
                ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
                data-post-id={post._id.toString()}
                playsInline
                muted={muted}
                loop
                src={post.content}
                className="w-full h-full object-cover rounded-md"
                preload="metadata"
                poster="https://placehold.co/600x400?text=Video+Loading"
                onError={() => console.warn('Video load error')}
              />
            )}
            {post.contentType === 'audio' && (
              <audio
                ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
                data-post-id={post._id.toString()}
                controls
                src={post.content}
                className="w-full mt-2 bg-gray-300 dark:bg-gray-700 rounded-full p-2"
                preload="metadata"
                onError={() => console.warn('Audio load error')}
              />
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

            <div className="absolute right-4 bottom-20 flex flex-col items-center space-y-6 z-10">
              <div whileHovering={{ scale: 1.2 }} className="motion-button">
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
              <div whileHovering={{ scale: 1.2 }} className="motion-button">
                <button
                  onClick={() => setShowComments(post._id.toString())}
                  className="flex flex-col items-center focus:outline-none focus:ring-2 focus:ring-blue-400"
                  aria-label="View comments"
                >
                  <FaComment className="text-3xl text-gray-900 dark:text-gray-100 hover:text-blue-500" />
                  <span className="text-sm text-gray-900 dark:text-gray-100">{post.comments?.length || 0}</span>
                </button>
              </div>
              <div whileHovering={{ scale: 1.2 }} className="motion-button">
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
              {post.contentType === 'video' && (
                <div whileHovering={{ scale: 1.2 }} className="motion-button">
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
                  className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 p-4 rounded-t-lg shadow-lg h-1/2 overflow-y-auto z-10 md:max-w-[600px] md:mx-auto"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby={`comments-${post._id}`}
                >
                  <h3 id={`Comments-${post._id}`} className="text-lg font-bold text-blue-600 dark:text-blue-400 mb-2">Comments</h3>
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
                          <span className="ms-2">{c.comment}</span>
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
};

export default FeedScreen;