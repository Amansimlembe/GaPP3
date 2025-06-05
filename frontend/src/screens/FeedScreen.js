import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPlus, FaPaperPlane, FaHeart, FaComment, FaShare, FaVolumeMute, FaVolumeUp, FaSyncAlt } from 'react-icons/fa';
import { useSwipeable } from 'react-swipeable';
import io from 'socket.io-client';
import debounce from 'lodash/debounce';

const socket = io('https://gapp-6yc3.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  withCredentials: true,
});

const FeedScreen = ({ token: initialToken, userId, onUnauthorized }) => {
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
  const [token, setToken] = useState(initialToken);
  const feedRef = useRef(null);
  const mediaRefs = useRef({});

  const refreshToken = useCallback(async () => {
    try {
      const { data } = await axios.post('https://gapp-6yc3.onrender.com/auth/refresh', { userId }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setToken(data.token);
      localStorage.setItem('token', data.token);
      return data.token;
    } catch (err) {
      console.error('Token refresh failed:', err);
      setError('Session expired. Please log in again.');
      onUnauthorized?.();
      return null;
    }
  }, [token, userId, onUnauthorized]);

  const setupIntersectionObserver = useCallback(
    debounce(() => {
      if (mediaRefs.current) {
        Object.values(mediaRefs.current).forEach((media) => media && mediaRefs.current[media.dataset.postId]?.pause?.());
      }

      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const media = entry.target;
            const postId = media.dataset.postId;
            if (entry.isIntersecting) {
              setPlayingPostId(postId);
              if (media.tagName === 'VIDEO') {
                media.play().catch((err) => console.error('Video play error:', err));
              }
            } else if (media.tagName === 'VIDEO') {
              media.pause();
              media.currentTime = 0;
            }
          });
        },
        { threshold: 0.8 }
      );

      Object.values(mediaRefs.current).forEach((media) => media && observer.observe(media));
      return () => observer.disconnect();
    }, 300),
    []
  );

  const fetchFeed = useCallback(async (pageNum = 1, isRefresh = false) => {
    if (!token || !userId || (loading && !isRefresh) || (!hasMore && !isRefresh)) return;
    setLoading(true);
    if (isRefresh) setRefreshing(true);
    try {
      const currentToken = token;
      const { data } = await axios.get(`https://gapp-6yc3.onrender.com/feed?page=${pageNum}&limit=10`, {
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      const filteredPosts = Array.isArray(data.posts) ? data.posts.filter((post) => !post.isStory) : [];
      setPosts((prev) => (pageNum === 1 || isRefresh ? filteredPosts : [...prev, ...filteredPosts]));
      setHasMore(data.hasMore || false);
      setError('');
      if (filteredPosts.length > 0 && (pageNum === 1 || isRefresh)) {
        setPlayingPostId(filteredPosts[0]._id);
      }
    } catch (error) {
      console.error('Failed to fetch feed:', error);
      if (error.response?.status === 401) {
        const newToken = await refreshToken();
        if (newToken) {
          await fetchFeed(pageNum, isRefresh);
        } else {
          setError('Unauthorized. Please log in again.');
          onUnauthorized?.();
        }
      } else {
        setError(error.response?.data?.error || 'Failed to load feed');
      }
    } finally {
      setLoading(false);
      if (isRefresh) setRefreshing(false);
    }
  }, [token, userId, loading, hasMore, refreshToken, onUnauthorized]);

  useEffect(() => {
    if (token && userId) {
      fetchFeed();
      socket.emit('join', userId);
    }

    socket.on('newPost', (post) => {
      if (!post.isStory) {
        setPosts((prev) => [post, ...prev.filter((p) => p._id !== post._id)]);
      }
    });
    socket.on('postUpdate', (updatedPost) => {
      setPosts((prev) => prev.map((p) => (p._id === updatedPost._id ? updatedPost : p)));
    });
    socket.on('postDeleted', (postId) => {
      setPosts((prev) => prev.filter((p) => p._id !== postId));
    });

    return () => {
      socket.off('newPost');
      socket.off('postUpdate');
      socket.off('postDeleted');
    };
  }, [token, userId, fetchFeed]);

  useEffect(() => {
    setupIntersectionObserver();
    if (posts.length > 0 && feedRef.current) {
      feedRef.current.scrollTo({ top: currentIndex * window.innerHeight, behavior: 'smooth' });
    }
  }, [posts, currentIndex, setupIntersectionObserver]);

  const handleScroll = useCallback(() => {
    if (!feedRef.current || loading || !hasMore) return;
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    if (scrollTop + clientHeight >= scrollHeight - 50) {
      setPage((prev) => prev + 1);
      fetchFeed(page + 1);
    }
  }, [loading, hasMore, page, fetchFeed]);

  useEffect(() => {
    const feedElement = feedRef.current;
    if (feedElement) {
      feedElement.addEventListener('scroll', handleScroll);
      return () => feedElement.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  const postContent = async () => {
    if (!userId || (!caption && !file && contentType !== 'text')) {
      setError('Please provide content');
      return;
    }
    const formData = new FormData();
    formData.append('userId', userId);
    formData.append('contentType', contentType);
    formData.append('caption', caption);
    if (file) formData.append('content', file);
    else if (contentType === 'text') formData.append('content', caption);

    try {
      setUploadProgress(0);
      const { data } = await axios.post('https://gapp-6yc3.onrender.com/feed', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
        onUploadProgress: (progressEvent) =>
          setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total)),
      });
      socket.emit('newPost', data);
      setPosts((prev) => [data, ...prev]);
      setCaption('');
      setFile(null);
      setShowPostModal(false);
      setUploadProgress(null);
      setError('');
      setCurrentIndex(0);
    } catch (error) {
      console.error('Post error:', error);
      if (error.response?.status === 401) {
        const newToken = await refreshToken();
        if (newToken) {
          await postContent();
        } else {
          setError('Unauthorized. Please log in again.');
          onUnauthorized?.();
        }
      } else {
        setError(error.response?.data?.error || 'Failed to post');
      }
      setUploadProgress(null);
    }
  };

  const likePost = async (postId) => {
    if (!playingPostId || postId !== playingPostId) return;
    try {
      const post = posts.find((p) => p._id === postId);
      const action = post.likedBy?.includes(userId) ? '/feed/unlike' : '/feed/like';
      const { data } = await axios.post(
        `https://gapp-6yc3.onrender.com${action}`,
        { postId, userId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      socket.emit('postUpdate', data);
    } catch (error) {
      console.error('Like error:', error);
      if (error.response?.status === 401) {
        const newToken = await refreshToken();
        if (newToken) {
          await likePost(postId);
        } else {
          setError('Unauthorized. Please log in again.');
          onUnauthorized?.();
        }
      }
    }
  };

  const commentPost = async (postId) => {
    if (!playingPostId || postId !== playingPostId || !comment.trim()) return;
    try {
      const { data } = await axios.post(
        'https://gapp-6yc3.onrender.com/feed/comment',
        { postId, comment, userId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const updatedPost = {
        ...posts.find((p) => p._id === postId),
        comments: [...(posts.find((p) => p._id === postId)?.comments || []), data],
      };
      socket.emit('postUpdate', updatedPost);
      setComment('');
    } catch (error) {
      console.error('Comment error:', error);
      if (error.response?.status === 401) {
        const newToken = await refreshToken();
        if (newToken) {
          await commentPost(postId);
        } else {
          setError('Unauthorized. Please log in again.');
          onUnauthorized?.();
        }
      }
    }
  };

  const timeAgo = (date) => {
    const now = new Date();
    const diff = now - parseInt(date);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };

  const handleRefresh = useCallback(() => {
    setPage(1);
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
  });

  const handleDoubleTap = (postId) => {
    likePost(postId);
  };

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
          className="bg-gradient-to-r from-blue-500 to-purple-600 text-white p-4 rounded-full shadow-lg"
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
                    onChange={(e) => setCaption(e.target.value)}
                    className="flex-1 p-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:outline-none transition duration-200 resize-none"
                    placeholder="What's on your mind?"
                    rows="4"
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
                        : '*/*'
                    }
                    onChange={(e) => setFile(e.target.files[0])}
                    className="flex-1 p-3 bg-gray-800 border border-gray-700 rounded-lg text-white file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-blue-500 file:text-white file:cursor-pointer"
                  />
                )}
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={postContent}
                  className="ml-3 p-3 bg-blue-500 rounded-full"
                >
                  <FaPaperPlane className="text-xl text-white" />
                </motion.button>
              </div>
              {contentType !== 'text' && (
                <input
                  type="text"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  className="w-full p-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:outline-none transition duration-200"
                  placeholder="Add a caption..."
                />
              )}
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowPostModal(false)}
                className="mt-4 w-full bg-gray-700 text-white p-3 rounded-lg hover:bg-gray-600 transition duration-200"
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
          className="text-red-500 text-center py-3 z-10 fixed top-0 w-full bg-black bg-opacity-75 md:max-w-[600px] md:mx-auto"
        >
          {error}
          {error.includes('Unauthorized') && (
            <button
              onClick={() => onUnauthorized?.()}
              className="ml-2 text-blue-500 underline"
            >
              Log In
            </button>
          )}
        </motion.div>
      )}

      {/* Refresh Indicator */}
      {refreshing && (
        <div className="fixed top-4 left-0 right-0 text-center text-white z-10">
          <FaSyncAlt className="inline-block w-6 h-6 animate-spin" />
        </div>
      )}

      {/* Loading Indicator */}
      {loading && !refreshing && (
        <div className="fixed bottom-4 left-0 right-0 text-center text-white">
          <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}

      {/* TikTok-like Feed */}
      {posts.length === 0 && !loading && !refreshing ? (
        <div className="h-screen flex items-center justify-center text-white">
          <p>No posts available</p>
        </div>
      ) : (
        posts.length === 0 && loading ? (
          [...Array(3)].map((_, i) => <LoadingSkeleton key={i} />)
        ) : (
          posts.map((post, index) => (
            <motion.div
              key={post._id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
              className="h-screen w-full flex flex-col items-center justify-center text-white relative snap-start md:max-w-[600px] md:mx-auto md:h-[800px] md:rounded-lg md:shadow-lg md:bg-gray-900"
              onDoubleClick={() => handleDoubleTap(post._id)}
            >
              {/* User Info */}
              <div className="absolute top-4 left-4 z-10 flex items-center">
                <img
                  src={post.photo || 'https://placehold.co/40x40'}
                  alt="Profile"
                  className="w-10 h-10 rounded-full mr-2 border-2 border-blue-500"
                />
                <div>
                  <span className="font-bold text-white">{post.username || 'Unknown'}</span>
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
                  alt="Post"
                  className="w-full h-full object-cover md:rounded-lg"
                  data-post-id={post._id}
                  ref={(el) => (mediaRefs.current[post._id] = el)}
                />
              )}
              {post.contentType === 'video' && (
                <video
                  ref={(el) => (mediaRefs.current[post._id] = el)}
                  data-post-id={post._id}
                  playsInline
                  autoPlay
                  muted={muted}
                  loop
                  src={post.content}
                  className="w-full h-full object-cover md:rounded-lg"
                />
              )}
              {post.contentType === 'audio' && (
                <audio
                  ref={(el) => (mediaRefs.current[post._id] = el)}
                  data-post-id={post._id}
                  controls
                  autoPlay
                  src={post.content}
                  className="w-full mt-4"
                />
              )}
              {post.contentType === 'raw' && (
                <a
                  href={post.content}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 p-4 bg-black bg-opacity-50 rounded-lg"
                >
                  Open Document
                </a>
              )}

              {/* Interactions */}
              <div className="absolute right-4 bottom-20 flex flex-col items-center space-y-6 z-10">
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaHeart
                    onClick={() => likePost(post._id)}
                    className={`text-3xl cursor-pointer ${post.likedBy?.includes(userId) ? 'text-red-500' : 'text-white'}`}
                  />
                  <span className="text-sm text-white">{post.likes || 0}</span>
                </motion.div>
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaComment
                    onClick={() => setShowComments(post._id)}
                    className="text-3xl cursor-pointer text-white hover:text-blue-500"
                  />
                  <span className="text-sm text-white">{post.comments?.length || 0}</span>
                </motion.div>
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaShare
                    onClick={() =>
                      navigator.clipboard
                        .writeText(`${window.location.origin}/post/${post._id}`)
                        .then(() => alert('Link copied!'))
                    }
                    className="text-3xl cursor-pointer text-white hover:text-blue-500"
                  />
                </motion.div>
                {post.contentType === 'video' && (
                  <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                    {muted ? (
                      <FaVolumeMute
                        onClick={() => setMuted(false)}
                        className="text-3xl cursor-pointer text-white hover:text-blue-500"
                      />
                    ) : (
                      <FaVolumeUp
                        onClick={() => setMuted(true)}
                        className="text-3xl cursor-pointer text-white hover:text-blue-500"
                      />
                    )}
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
                {showComments === post._id && (
                  <motion.div
                    initial={{ opacity: 0, y: 100 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 100 }}
                    className="fixed bottom-0 left-0 right-0 bg-gray-900 text-white p-4 rounded-t-lg shadow-lg h-1/2 overflow-y-auto z-50 md:max-w-[600px] md:mx-auto"
                  >
                    <h3 className="text-lg font-bold text-blue-500 mb-2">Comments</h3>
                    {post.comments?.length === 0 ? (
                      <p className="text-gray-400">No comments yet</p>
                    ) : (
                      post.comments.map((c, i) => (
                        <div key={i} className="flex items-center mb-3">
                          <img
                            src={c.photo || 'https://placehold.co/30x30'}
                            alt="Profile"
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
                        onChange={(e) => setComment(e.target.value)}
                        className="flex-1 p-3 bg-gray-800 border border-gray-700 rounded-full text-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        placeholder="Add a comment..."
                      />
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => commentPost(post._id)}
                        className="ml-3 p-3 bg-blue-500 rounded-full"
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
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40" onClick={() => setShowComments(null)} />
      )}
    </motion.div>
  );
};

export default FeedScreen;