import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPlus, FaPaperPlane, FaHeart, FaComment, FaShare, FaVolumeMute, FaVolumeUp, FaSyncAlt } from 'react-icons/fa';
import { useSwipeable } from 'react-swipeable';
import debounce from 'lodash/debounce';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const FeedScreen = ({ token, userId, socket, onUnauthorized }) => {
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
  const [muted, setMuted] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const feedRef = useRef(null);
  const mediaRefs = useRef({});

  // Changed: Add retry logic for API calls
  const retryOperation = async (operation, maxRetries = 3, baseDelay = 1000) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!navigator.onLine) throw new Error('Offline');
        return await operation();
      } catch (err) {
        if (attempt === maxRetries || err.response?.status === 401) {
          throw err;
        }
        const delay = Math.pow(2, attempt) * baseDelay;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  // Changed: Optimize IntersectionObserver
  const setupIntersectionObserver = useCallback(
    debounce(() => {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const media = entry.target;
            const postId = media.dataset.postId;
            if (entry.isIntersecting && !showComments) {
              setPlayingPostId(postId);
              if (media.tagName === 'VIDEO') {
                media.play().catch((err) => console.warn('Video play error:', err));
              }
            } else if (media.tagName === 'VIDEO') {
              media.pause();
              media.currentTime = 0;
            }
          });
        },
        { threshold: 0.6 } // Changed: Lower threshold for smoother transitions
      );

      Object.values(mediaRefs.current).forEach((media) => media && observer.observe(media));
      return () => {
        observer.disconnect();
        Object.values(mediaRefs.current).forEach((media) => {
          if (media?.tagName === 'VIDEO') {
            media.pause();
            media.src = '';
          }
        });
      };
    }, 300),
    [showComments]
  );

  // Changed: Optimize fetchFeed with retry and deduplication
  const fetchFeed = useCallback(
    async (pageNum = 1, isRefresh = false) => {
      if (!token || !userId || (loading && !isRefresh) || (!hasMore && !isRefresh)) return;
      setLoading(true);
      if (isRefresh) setRefreshing(true);
      try {
        const { data } = await retryOperation(() =>
          axios.get(`${BASE_URL}/feed?page=${pageNum}&limit=10`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
          })
        );
        const filteredPosts = Array.isArray(data.posts)
          ? data.posts.filter((post) => !post.isStory && post._id)
          : [];
        setPosts((prev) => {
          const newPosts = pageNum === 1 || isRefresh ? filteredPosts : [...prev, ...filteredPosts];
          // Deduplicate posts
          const uniquePosts = Array.from(
            new Map(newPosts.map((post) => [post._id.toString(), post])).values()
          );
          return uniquePosts;
        });
        setHasMore(data.hasMore || false);
        setError('');
        if (filteredPosts.length > 0 && (pageNum === 1 || isRefresh)) {
          setPlayingPostId(filteredPosts[0]._id.toString());
        }
      } catch (error) {
        console.error('Failed to fetch feed:', error);
        if (error.response?.status === 401 || error.message === 'Offline') {
          setError(error.message === 'Offline' ? 'You are offline' : 'Unauthorized. Please log in again.');
          if (error.response?.status === 401) onUnauthorized?.();
        } else {
          setError(error.response?.data?.error || 'Failed to load feed');
        }
      } finally {
        setLoading(false);
        if (isRefresh) setRefreshing(false);
      }
    },
    [token, userId, loading, hasMore, onUnauthorized]
  );

  // Changed: Optimize socket setup and cleanup
  useEffect(() => {
    if (!token || !userId || !socket) return;

    fetchFeed();
    socket.emit('join', userId);

    const handleNewPost = (post) => {
      if (!post.isStory && post._id) {
        setPosts((prev) => {
          const newPosts = [post, ...prev];
          // Deduplicate
          return Array.from(new Map(newPosts.map((p) => [p._id.toString(), p])).values());
        });
      }
    };

    const handlePostUpdate = (updatedPost) => {
      if (updatedPost._id) {
        setPosts((prev) =>
          prev.map((p) => (p._id.toString() === updatedPost._id.toString() ? updatedPost : p))
        );
      }
    };

    const handlePostDeleted = (postId) => {
      if (postId) {
        setPosts((prev) => prev.filter((p) => p._id.toString() !== postId.toString()));
      }
    };

    socket.on('newPost', handleNewPost);
    socket.on('postUpdate', handlePostUpdate);
    socket.on('postDeleted', handlePostDeleted);

    return () => {
      socket.off('newPost', handleNewPost);
      socket.off('postUpdate', handlePostUpdate);
      socket.off('postDeleted', handlePostDeleted);
    };
  }, [token, userId, socket, fetchFeed]);

  // Changed: Optimize scroll handling with debounce
  const handleScroll = useCallback(
    debounce(() => {
      if (!feedRef.current || loading || !hasMore) return;
      const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
      if (scrollTop + clientHeight >= scrollHeight - 100) { // Changed: Increase threshold
        setPage((prev) => prev + 1);
        fetchFeed(page + 1);
      }
    }, 200),
    [loading, hasMore, page, fetchFeed]
  );

  useEffect(() => {
    const cleanup = setupIntersectionObserver();
    const feedElement = feedRef.current;
    if (feedElement) {
      feedElement.addEventListener('scroll', handleScroll);
      if (posts.length > 0) {
        feedElement.scrollTo({ top: currentIndex * window.innerHeight, behavior: 'smooth' });
      }
    }
    return () => {
      if (feedElement) feedElement.removeEventListener('scroll', handleScroll);
      cleanup();
    };
  }, [posts, currentIndex, setupIntersectionObserver, handleScroll]);

  // Changed: Optimize postContent with retry
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
        axios.post(`${BASE_URL}/feed`, formData, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'multipart/form-data',
          },
          onUploadProgress: (progressEvent) =>
            setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total)),
          timeout: 15000, // Changed: Increase timeout for uploads
        })
      );
      socket.emit('newPost', data);
      setPosts((prev) => {
        const newPosts = [data, ...prev];
        return Array.from(new Map(newPosts.map((p) => [p._id.toString(), p])).values());
      });
      setCaption('');
      setFile(null);
      setShowPostModal(false);
      setUploadProgress(null);
      setError('');
      setCurrentIndex(0);
    } catch (error) {
      console.error('Post error:', error);
      if (error.response?.status === 401 || error.message === 'Offline') {
        setError(error.message === 'Offline' ? 'You are offline' : 'Unauthorized. Please log in again.');
        if (error.response?.status === 401) onUnauthorized?.();
      } else {
        setError(error.response?.data?.error || 'Failed to post');
      }
      setUploadProgress(null);
    }
  };

  // Changed: Optimize likePost with retry
  const likePost = async (postId) => {
    if (!playingPostId || postId !== playingPostId) return;
    try {
      const post = posts.find((p) => p._id.toString() === postId);
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
    } catch (error) {
      console.error('Like error:', error);
      if (error.response?.status === 401 || error.message === 'Offline') {
        setError(error.message === 'Offline' ? 'You are offline' : 'Unauthorized. Please log in again.');
        if (error.response?.status === 401) onUnauthorized?.();
      }
    }
  };

  // Changed: Optimize commentPost with retry
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
      const updatedPost = {
        ...posts.find((p) => p._id.toString() === postId),
        comments: [...(posts.find((p) => p._id.toString() === postId)?.comments || []), data],
      };
      socket.emit('postUpdate', updatedPost);
      setComment('');
      setShowComments(null);
    } catch (error) {
      console.error('Comment error:', error);
      if (error.response?.status === 401 || error.message === 'Offline') {
        setError(error.message === 'Offline' ? 'You are offline' : 'Unauthorized. Please log in again.');
        if (error.response?.status === 401) onUnauthorized?.();
      }
    }
  };

  const timeAgo = useCallback((date) => {
    const now = new Date();
    const diff = now - new Date(date);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }, []);

  const handleRefresh = useCallback(() => {
    setPage(1);
    setCurrentIndex(0);
    fetchFeed(1, true);
  }, [fetchFeed]);

  // Changed: Optimize swipe handlers
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
    preventDefaultTouchmoveEvent: true, // Changed: Prevent browser scrolling
  });

  const handleDoubleTap = useCallback((postId) => {
    likePost(postId);
  }, [likePost]);

  const LoadingSkeleton = () => (
    <div className="h-screen w-full bg-gray-200 animate-pulse relative snap-start md:max-w-[600px] md:h-[800px] md:rounded-lg">
      <div className="absolute top-4 left-4 flex items-center">
        <div className="w-10 h-10 rounded-full bg-gray-300"></div>
        <div className="ml-2">
          <div className="w-20 h-4 bg-gray-300 rounded"></div>
          <div className="w-10 h-3 mt-1 bg-gray-300 rounded"></div>
        </div>
      </div>
      <div className="w-full h-full bg-gray-300"></div>
      <div className="absolute right-4 bottom-20 flex flex-col space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="w-8 h-8 bg-gray-300 rounded-full"></div>
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
      className="h-screen overflow-y-auto bg-black snap-y snap-mandatory md:max-w-[600px] md:mx-auto md:rounded-lg md:shadow-lg"
    >
      {/* Floating Post Button */}
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

      {/* Post Modal */}
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
            <div className="bg-gray-900 text-white p-6 rounded-2xl shadow-2xl w-full max-w-md relative">
              {uploadProgress !== null && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-75">
                  <div className="relative w-20 h-20">
                    <svg className="w-full h-full" viewBox="0 0 36 36">
                      <path
                        className="text-gray-700"
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
                  className="w-full p-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:outline-none transition duration-200"
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
                    onChange={(e) => setCaption(e.target.value.slice(0, 500))} // Changed: Limit caption length
                    className="flex-1 p-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:outline-none transition duration-200 resize-none"
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
                    className="flex-1 p-3 bg-gray-800 border border-gray-700 rounded-lg text-white file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-blue-500 file:text-white file:cursor-pointer"
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
                  onChange={(e) => setCaption(e.target.value.slice(0, 500))} // Changed: Limit caption length
                  className="w-full p-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:outline-none transition duration-200"
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
                className="mt-4 w-full bg-gray-700 text-white p-3 rounded-lg hover:bg-gray-600 transition duration-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                aria-label="Cancel post"
              >
                Cancel
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error Display */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="text-red-500 text-center py-3 z-10 fixed top-0 w-full bg-black bg-opacity-75 md:max-w-[600px] md:mx-auto"
          role="alert"
        >
          {error}
          {error.includes('Unauthorized') && (
            <button
              onClick={() => onUnauthorized?.()}
              className="ml-2 text-blue-500 underline focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Log in"
            >
              Log In
            </button>
          )}
        </motion.div>
      )}

      {/* Refresh Indicator */}
      {refreshing && (
        <div className="fixed top-4 left-0 right-0 text-center text-white z-10">
          <FaSyncAlt className="inline-block w-6 h-6 animate-spin" aria-label="Refreshing feed" />
        </div>
      )}

      {/* Loading Indicator */}
      {loading && !refreshing && (
        <div className="fixed bottom-4 left-0 right-0 text-center text-white">
          <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" aria-label="Loading more posts"></div>
        </div>
      )}

      {/* TikTok-like Feed */}
      {posts.length === 0 && !loading && !refreshing ? (
        <div className="h-screen flex items-center justify-center text-white" role="status">
          <p>No posts available</p>
        </div>
      ) : (
        posts.length === 0 && loading ? (
          [...Array(3)].map((_, i) => <LoadingSkeleton key={i} />)
        ) : (
          posts.map((post, index) => (
            <motion.div
              key={post._id.toString()}
              initial={{ opacity: 0 }}
              animate={{ opacity: index === currentIndex ? 1 : 0.5 }}
              transition={{ duration: 0.3 }}
              className="h-screen w-full flex flex-col items-center justify-center text-white relative snap-start md:max-w-[600px] md:mx-auto md:h-[800px] md:rounded-lg md:shadow-lg md:bg-gray-900"
              onDoubleClick={() => handleDoubleTap(post._id.toString())}
              role="article"
              aria-labelledby={`post-${post._id}`}
            >
              {/* User Info */}
              <div className="absolute top-4 left-4 z-10 flex items-center">
                <img
                  src={post.photo || 'https://placehold.co/40x40'}
                  alt={`${post.username || 'Unknown'}'s profile`}
                  className="w-10 h-10 rounded-full mr-2 border-2 border-blue-500"
                />
                <div>
                  <span id={`post-${post._id}`} className="font-bold text-white">{post.username || 'Unknown'}</span>
                  <span className="text-xs ml-2 text-gray-400">{timeAgo(post.createdAt)}</span>
                </div>
              </div>

              {/* Post Content */}
              {post.contentType === 'text' && (
                <p className="text-lg p-4 bg-black bg-opacity-50 rounded-lg max-w-[80%] mx-auto text-center">
                  {post.content}
                </p>
              )}
              {post.contentType === 'image' && (
                <img
                  src={post.content}
                  alt="Post image"
                  className="w-full h-full object-cover md:rounded-lg"
                  data-post-id={post._id.toString()}
                  ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
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
                  className="w-full h-full object-cover md:rounded-lg"
                  preload="metadata" // Changed: Optimize video loading
                />
              )}
              {post.contentType === 'audio' && (
                <audio
                  ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
                  data-post-id={post._id.toString()}
                  controls
                  src={post.content}
                  className="w-full mt-4"
                  preload="metadata" // Changed: Optimize audio loading
                />
              )}
              {post.contentType === 'raw' && (
                <a
                  href={post.content}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 p-4 bg-black bg-opacity-50 rounded-lg"
                  aria-label="Open document"
                >
                  Open Document
                </a>
              )}

              {/* Interactions */}
              <div className="absolute right-4 bottom-20 flex flex-col items-center space-y-6 z-10">
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <button
                    onClick={() => likePost(post._id.toString())}
                    className="focus:outline-none focus:ring-2 focus:ring-red-500"
                    aria-label={post.likedBy?.map((id) => id.toString()).includes(userId) ? 'Unlike post' : 'Like post'}
                  >
                    <FaHeart
                      className={`text-3xl ${post.likedBy?.map((id) => id.toString()).includes(userId) ? 'text-red-500' : 'text-white'}`}
                    />
                    <span className="text-sm text-white">{post.likes || 0}</span>
                  </button>
                </motion.div>
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <button
                    onClick={() => setShowComments(post._id.toString())}
                    className="focus:outline-none focus:ring-2 focus:ring-blue-500"
                    aria-label="View comments"
                  >
                    <FaComment className="text-3xl text-white hover:text-blue-500" />
                    <span className="text-sm text-white">{post.comments?.length || 0}</span>
                  </button>
                </motion.div>
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <button
                    onClick={() =>
                      navigator.clipboard
                        .writeText(`${window.location.origin}/post/${post._id.toString()}`)
                        .then(() => alert('Link copied!'))
                    }
                    className="focus:outline-none focus:ring-2 focus:ring-blue-500"
                    aria-label="Share post"
                  >
                    <FaShare className="text-3xl text-white hover:text-blue-500" />
                  </button>
                </motion.div>
                {post.contentType === 'video' && (
                  <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                    <button
                      onClick={() => setMuted((prev) => !prev)}
                      className="focus:outline-none focus:ring-2 focus:ring-blue-500"
                      aria-label={muted ? 'Unmute video' : 'Mute video'}
                    >
                      {muted ? (
                        <FaVolumeMute className="text-3xl text-white hover:text-blue-500" />
                      ) : (
                        <FaVolumeUp className="text-3xl text-white hover:text-blue-500" />
                      )}
                    </button>
                  </motion.div>
                )}
              </div>

              {/* Caption */}
              {post.caption && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute bottom-4 left-4 right-4 text-sm bg-black bg-opacity-50 p-3 rounded-lg max-w-[70%] md:max-w-[80%]"
                >
                  <span className="font-bold text-white">{post.username || 'Unknown'}</span>
                  <span className="ml-2 text-white">{post.caption}</span>
                </motion.div>
              )}

              {/* Comments Modal */}
              <AnimatePresence>
                {showComments === post._id.toString() && (
                  <motion.div
                    initial={{ opacity: 0, y: 100 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 100 }}
                    className="fixed bottom-0 left-0 right-0 bg-gray-900 text-white p-4 rounded-t-lg shadow-lg h-1/2 overflow-y-auto z-50 md:max-w-[600px] md:mx-auto"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={`comments-${post._id}`}
                  >
                    <h3 id={`comments-${post._id}`} className="text-lg font-bold text-blue-500 mb-2">Comments</h3>
                    {post.comments?.length === 0 ? (
                      <p className="text-gray-400">No comments yet</p>
                    ) : (
                      post.comments.map((c, i) => (
                        <div key={`${c.createdAt}-${i}`} className="flex items-center mb-3">
                          <img
                            src={c.photo || 'https://placehold.co/30x30'}
                            alt={`${c.username || 'Unknown'}'s profile`}
                            className="w-8 h-8 rounded-full mr-2 border border-gray-700"
                          />
                          <p className="text-sm text-white">
                            <span className="font-semibold">{c.username || 'Unknown'}</span> {c.comment}
                          </p>
                        </div>
                      ))
                    )}
                    <div className="flex items-center mt-3">
                      <input
                        value={comment}
                        onChange={(e) => setComment(e.target.value.slice(0, 500))} // Changed: Limit comment length
                        className="flex-1 p-3 bg-gray-800 border border-gray-700 rounded-full text-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        placeholder="Add a comment... (max 500 chars)"
                        aria-label="Add comment"
                      />
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => commentPost(post._id.toString())}
                        className="ml-3 p-3 bg-blue-500 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500"
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
        )
      )}

      {/* Comments Overlay */}
      {showComments && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40"
          onClick={() => setShowComments(null)}
          aria-hidden="true"
        />
      )}
    </motion.div>
  );
};

export default FeedScreen;