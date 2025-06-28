import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPlus, FaPaperPlane, FaHeart, FaComment, FaShare, FaVolumeMute, FaVolumeUp, FaSyncAlt, FaTextHeight, FaImage, FaVideo, FaMusic, FaFilePdf, FaUser } from 'react-icons/fa';
import { useSwipeable } from 'react-swipeable';
import debounce from 'lodash/debounce';
import PropTypes from 'prop-types';
import { formatDistanceToNow } from 'date-fns';
import { FixedSizeList } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { Document, Page, pdfjs } from 'react-pdf';

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

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
  const [showUserPosts, setShowUserPosts] = useState(false);
  const [pdfPageIndices, setPdfPageIndices] = useState({});
  const feedRef = useRef(null);
  const mediaRefs = useRef({});
  const isFetchingFeedRef = useRef(false);
  const [likeAnimation, setLikeAnimation] = useState(null);
  const modalRef = useRef(null);

  const retryOperation = async (operation, maxRetries = 3, baseDelay = 1000) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!navigator.onLine) throw new Error('Offline');
        return await operation();
      } catch (err) {
        console.error(`Retry attempt ${attempt} failed:`, err.response?.data || err.message);
        const errorMessage = err.response?.status === 401
          ? 'Authentication error'
          : err.response?.status === 429
          ? 'Too many requests'
          : err.message === 'Offline'
          ? 'You are offline'
          : 'Network error';
        setError(`${errorMessage}. Attempt ${attempt}/${maxRetries}`);
        if (err.response?.status === 401 && showUserPosts) {
          const newToken = await refreshToken();
          if (newToken) continue;
          setError('Authentication failed. Please log in again.');
          return null;
        }
        if (err.response?.status === 429) {
          setError('Too many requests. Please try again later.');
          return null;
        }
        if (attempt === maxRetries) {
          setError(`${errorMessage}. Retry failed.`);
          throw err;
        }
        const delay = Math.pow(2, attempt) * baseDelay;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  const refreshToken = async () => {
    try {
      const storedToken = localStorage.getItem('token');
      const storedUserId = localStorage.getItem('userId');
      if (!storedToken || !storedUserId) throw new Error('Missing token or userId');
      const response = await axios.post(
        `${BASE_URL}/auth/refresh`,
        { userId: storedUserId },
        { headers: { Authorization: `Bearer ${storedToken}` }, timeout: 5000 }
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

  const pauseAllMedia = useCallback(() => {
    Object.values(mediaRefs.current).forEach((media) => {
      if (media?.tagName === 'VIDEO' || media?.tagName === 'AUDIO') {
        media.pause();
        media.currentTime = 0;
      }
    });
  }, []);

  const setupIntersectionObserver = useCallback(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const media = entry.target;
          const postId = media.dataset.postId;
          if (!postId) return;
          if (entry.isIntersecting && !showComments && !showPostModal) {
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
  }, [showComments, showPostModal]);

  const fetchFeed = useCallback(
    debounce(async (pageNum = 1, isRefresh = false) => {
      if (isFetchingFeedRef.current || (!hasMore && !isRefresh)) return;
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
        const headers = showUserPosts ? { Authorization: `Bearer ${token}` } : {};
        const { data } = await retryOperation(() =>
          axios.get(url, { headers, timeout: 5000 })
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
            ? 'You are offline. Please check your connection.'
            : `Failed to load ${showUserPosts ? 'your posts' : 'feed'}. Tap to retry.`
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
      if (!token || typeof token !== 'string' || !token.includes('.')) return null;
      const base64Url = token.split('.')[1];
      if (!base64Url) return null;
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const decoded = JSON.parse(jsonPayload);
      return decoded.exp ? decoded.exp * 1000 : null;
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
    setIsAuthLoaded(true);
    fetchFeed(1);

    if (!socket) {
      console.warn('Socket not available');
      setError('Connecting to server...');
      return;
    }

    const socketTimeout = setTimeout(() => {
      if (!socket.connected) {
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

    socket.on('connect', () => {
      setSocketConnected(true);
      setError('');
      socket.emit('join', userId);
      socketPing();
    });
    socket.on('newPost', handleNewPost);
    socket.on('postUpdate', handlePostUpdate);
    socket.on('connect_error', async (error) => {
      console.error('Socket connect error:', error.message);
      setSocketConnected(false);
      setError('Connection lost. Trying to reconnect...');
      if (error.message.includes('invalid token') && showUserPosts) {
        const newToken = await refreshToken();
        if (newToken) {
          socket.auth.token = newToken;
          socket.connect();
        } else {
          setError('Authentication error. Please log in again.');
        }
      }
    });
    socket.on('reconnect', () => {
      setSocketConnected(true);
      setError('');
      socket.emit('join', userId);
      socketPing();
    });

    return () => {
      clearTimeout(socketTimeout);
      socket.off('connect');
      socket.off('newPost', handleNewPost);
      socket.off('postUpdate', handlePostUpdate);
      socket.off('connect_error');
      socket.off('reconnect');
      socket.off('pong');
      if (socket.connected) socket.emit('leave', userId);
    };
  }, [token, userId, socket, fetchFeed, socketPing, page, saveToCache, showUserPosts]);

  useEffect(() => {
    localStorage.setItem('feedMuted', muted);
  }, [muted]);

  useEffect(() => {
    if (showPostModal || showComments) {
      pauseAllMedia();
    }
  }, [showPostModal, showComments, pauseAllMedia]);

  const postContent = async () => {
    if (!userId || !token) {
      setError('Authentication required. Please log in again.');
      return;
    }
    if (!caption.trim() && !file && contentType !== 'text' && contentType !== 'raw') {
      setError('Please provide a caption or file');
      return;
    }
    if ((contentType === 'image' || contentType === 'video' || contentType === 'video+audio' || contentType === 'raw') && !file) {
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
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
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
      setError(error.message === 'Offline' ? 'You are offline. Please check your connection.' : 'Failed to post content.');
      setUploadProgress(null);
    }
  };

  const likePost = async (postId) => {
    if (!playingPostId || postId !== playingPostId || !token) return;
    const post = posts.find((p) => p._id.toString() === postId);
    if (!post) return;

    setPosts((prev) => prev.map((p) => {
      if (p._id.toString() !== postId) return p;
      const isLiked = p.likedBy?.map((id) => id.toString()).includes(userId);
      return {
        ...p,
        likes: isLiked ? p.likes - 1 : p.likes + 1,
        likedBy: isLiked
          ? p.likedBy.filter((id) => id.toString() !== userId)
          : [...p.likedBy, userId],
      };
    }));
    setLikeAnimation(postId);
    setTimeout(() => setLikeAnimation(null), 1000);

    try {
      const action = post.likedBy?.map((id) => id.toString()).includes(userId) ? '/unlike' : '/like';
      const { data } = await retryOperation(() =>
        axios.post(
          `${BASE_URL}/feed${action}`,
          { postId, userId },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
        )
      );
      socket.emit('postUpdate', data);
    } catch (error) {
      console.error('Like error:', error.message);
      setError(error.message === 'Offline' ? 'You are offline. Please check your connection.' : 'Failed to like post.');
      setPosts((prev) => prev.map((p) => (p._id.toString() === postId ? post : p)));
    }
  };

  const commentPost = async (postId) => {
    if (!playingPostId || postId !== playingPostId || !comment.trim() || !token) return;
    const post = posts.find((p) => p._id.toString() === postId);
    if (!post) return;

    const newComment = {
      userId,
      comment: comment.trim(),
      username: localStorage.getItem('username') || 'Guest',
      photo: localStorage.getItem('photo') || 'https://via.placeholder.com/30',
      createdAt: new Date().toISOString(),
    };
    setPosts((prev) => prev.map((p) => (
      p._id.toString() === postId
        ? { ...p, comments: [...p.comments, newComment] }
        : p
    )));

    try {
      const { data } = await retryOperation(() =>
        axios.post(
          `${BASE_URL}/feed/comment`,
          { postId, comment: comment.trim(), userId },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
        )
      );
      socket.emit('postUpdate', {
        ...post,
        comments: [...post.comments, data],
      });
      setComment('');
      setShowComments(null);
    } catch (error) {
      console.error('Comment error:', error.message);
      setError(error.message === 'Offline' ? 'You are offline. Please check your connection.' : 'Failed to comment.');
      setPosts((prev) => prev.map((p) => (p._id.toString() === postId ? post : p)));
    }
  };

  const timeAgo = useCallback((date) => {
    if (!date) return 'Unknown';
    try {
      return formatDistanceToNow(new Date(date), { addSuffix: true });
    } catch (error) {
      console.warn('Invalid date:', date);
      return 'Invalid date';
    }
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

  const handlePdfPageChange = (postId, index) => {
    setPdfPageIndices((prev) => ({ ...prev, [postId]: index }));
  };

  const swipeHandlers = useSwipeable({
    onSwipedUp: () => {
      if (showComments || showPostModal) return;
      setCurrentIndex((prev) => Math.min(prev + 1, posts.length - 1));
    },
    onSwipedDown: () => {
      if (showComments || showPostModal) return;
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
      if (!showComments && !showPostModal && playingPostId) setShowComments(playingPostId);
    },
    trackMouse: false,
    delta: 30,
    preventScrollOnSwipe: true,
  });

  const handleDoubleTap = useCallback((postId) => {
    likePost(postId);
  }, [likePost]);

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

  const PostRow = ({ index, style }) => {
    const post = posts[index];
    if (!post) return null;

    return (
      <motion.div
        style={style}
        key={post._id.toString()}
        initial={{ opacity: 0 }}
        animate={{ opacity: index === currentIndex ? 1 : 0.5 }}
        transition={{ duration: 0.3 }}
        className="w-full flex flex-col items-center justify-center text-gray-900 dark:text-gray-100 relative snap-start md:max-w-[600px] md:h-[800px] md:rounded-lg md:shadow-lg md:bg-gray-100 dark:md:bg-gray-900 px-4"
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
          <img
            src={post.content[0]}
            alt="Text post"
            className="w-full max-w-[600px] aspect-square object-contain rounded-md"
            data-post-id={post._id.toString()}
            ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
            onError={(e) => (e.target.src = 'https://placehold.co/600x600?text=Text+Error')}
            loading={index > currentIndex + 1 || index < currentIndex - 1 ? 'lazy' : 'eager'}
          />
        )}
        {post.contentType === 'image' && (
          <img
            src={post.content[0]}
            alt="Post image"
            className="w-full max-w-[600px] aspect-square object-contain rounded-md"
            data-post-id={post._id.toString()}
            ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
            onError={(e) => (e.target.src = 'https://placehold.co/600x600?text=Image+Error')}
            loading={index > currentIndex + 1 || index < currentIndex - 1 ? 'lazy' : 'eager'}
          />
        )}
        {post.contentType === 'video' && (
          <div className="relative w-full max-w-[600px] aspect-[9/16]">
            <video
              ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
              data-post-id={post._id.toString()}
              playsInline
              muted={muted}
              loop
              src={post.content[0]}
              className="w-full h-full object-contain rounded-md"
              preload={index === currentIndex ? 'auto' : 'none'}
              poster="https://placehold.co/600x1066?text=Video+Loading"
              onError={() => console.warn('Video load error')}
              aria-label="Video post"
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
          <div className="relative w-full max-w-[600px] aspect-[9/16]">
            <video
              ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
              data-post-id={post._id.toString()}
              playsInline
              muted={muted}
              loop
              src={post.content[0]}
              className="w-full h-full object-contain rounded-md"
              preload={index === currentIndex ? 'auto' : 'none'}
              poster="https://placehold.co/600x1066?text=Video+Loading"
              onError={() => console.warn('Video load error')}
              aria-label="Video with audio post"
            />
            <audio
              ref={(el) => (mediaRefs.current[`audio-${post._id.toString()}`] = el)}
              data-post-id={post._id.toString()}
              src={post.audioContent}
              loop
              muted={muted}
              preload={index === currentIndex ? 'auto' : 'none'}
              onError={() => console.warn('Audio load error')}
              aria-label="Audio track"
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
          <div className="relative w-full max-w-[600px] aspect-square flex items-center justify-center">
            <motion.div
              animate={{
                background: ['linear-gradient(45deg, #4b6cb7, #182848)', 'linear-gradient(45deg, #182848, #4b6cb7)'],
              }}
              transition={{ repeat: Infinity, duration: 5, ease: 'linear' }}
              className="absolute inset-0 rounded-md"
            />
            <audio
              ref={(el) => (mediaRefs.current[post._id.toString()] = el)}
              data-post-id={post._id.toString()}
              controls
              src={post.content[0]}
              className="w-full max-w-[80%] mt-2 bg-gray-300 dark:bg-gray-700 rounded-full p-2 z-10"
              preload={index === currentIndex ? 'auto' : 'none'}
              onError={() => console.warn('Audio load error')}
              aria-label="Audio post"
            />
            <motion.div
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              className="absolute bottom-4 right-4 flex items-center space-x-2 text-white bg-black bg-opacity-50 p-2 rounded-full z-10"
            >
              <FaMusic className="text-lg" />
              <span className="text-sm">Audio Playing</span>
            </motion.div>
          </div>
        )}
        {post.contentType === 'raw' && (
          <div className="relative w-full max-w-[600px] aspect-square overflow-x-auto snap-x snap-mandatory flex">
            <Document
              file={post.content[0]}
              onLoadError={() => console.warn('PDF load error')}
              loading={<div className="w-full h-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">Loading PDF...</div>}
            >
              {post.content.map((_, idx) => (
                <Page
                  key={`${post._id}-${idx}`}
                  pageNumber={idx + 1}
                  width={600}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  className="snap-center"
                  data-post-id={post._id.toString()}
                  ref={(el) => (mediaRefs.current[`${post._id.toString()}-${idx}`] = el?.canvas)}
                  loading={index > currentIndex + 1 || index < currentIndex - 1 ? 'lazy' : 'eager'}
                />
              ))}
            </Document>
            {post.content.length > 1 && (
              <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex space-x-2">
                {post.content.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => handlePdfPageChange(post._id.toString(), idx)}
                    className={`w-2 h-2 rounded-full ${pdfPageIndices[post._id.toString()] === idx ? 'bg-blue-500' : 'bg-gray-300'}`}
                    aria-label={`Go to PDF page ${idx + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
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
          {(post.contentType === 'video' || post.contentType === 'video+audio' || post.contentType === 'audio') && (
            <div className="motion-button">
              <button
                onClick={() => setMuted((prev) => !prev)}
                className="flex flex-col items-center focus:outline-none focus:ring-2 focus:ring-blue-400"
                aria-label={muted ? 'Unmute media' : 'Mute media'}
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
    );
  };

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
          <p>Loading...</p>
        </div>
      )}
      {error && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-500 text-white p-4 rounded-lg shadow-lg z-50 max-w-md w-full">
          <p className="text-sm">{error}</p>
          <div className="flex justify-end space-x-2 mt-2">
            <button
              className="bg-white text-red-500 px-3 py-1 rounded hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-white"
              onClick={() => setError('')}
              aria-label="Dismiss error"
            >
              OK
            </button>
            {error.includes('Failed to load') && (
              <button
                className="bg-white text-red-500 px-3 py-1 rounded hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-white"
                onClick={handleRefresh}
                aria-label="Retry loading feed"
              >
                Retry
              </button>
            )}
          </div>
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
        >
          <FaUser className="text-xl" />
        </motion.button>
      </div>
      <div className="fixed bottom-20 right-4 z-20">
        <motion.button
          whileHover={{ scale: 1.1, rotate: 90 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => {
            setShowPostModal(true);
            setTimeout(() => modalRef.current?.focus(), 100);
          }}
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
            tabIndex={-1}
            ref={modalRef}
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
                    { type: 'video+audio', icon: <FaVideo /> },
                    { type: 'raw', icon: <FaFilePdf /> },
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
                          : contentType === 'audio'
                          ? 'audio/mpeg,audio/wav'
                          : 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
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
        <AutoSizer>
          {({ height, width }) => (
            <FixedSizeList
              height={height}
              width={width}
              itemCount={posts.length}
              itemSize={window.innerHeight - 80}
              onItemsRendered={({ visibleStartIndex }) => setCurrentIndex(visibleStartIndex)}
            >
              {PostRow}
            </FixedSizeList>
          )}
        </AutoSizer>
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
  token: PropTypes.string,
  userId: PropTypes.string,
  socket: PropTypes.object.isRequired,
  onLogout: PropTypes.func.isRequired,
  theme: PropTypes.string,
};

FeedScreen.defaultProps = {
  token: null,
  userId: null,
  theme: 'light',
};

export default FeedScreen;