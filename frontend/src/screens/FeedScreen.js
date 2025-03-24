import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPlus, FaPaperPlane, FaHeart, FaComment, FaShare } from 'react-icons/fa';
import io from 'socket.io-client';

const socket = io('https://gapp-6yc3.onrender.com');
const cache = new Map();

const FeedScreen = ({ token, userId }) => {
  const [posts, setPosts] = useState([]);
  const [contentType, setContentType] = useState('text');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState(null);
  const [showPostModal, setShowPostModal] = useState(false);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [showComments, setShowComments] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [playingPostId, setPlayingPostId] = useState(null);
  const mediaRefs = useRef({});

  useEffect(() => {
    const fetchFeed = async () => {
      try {
        const { data } = await axios.get('/social/feed', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const randomizedPosts = data.filter(post => !post.isStory).sort(() => Math.random() - 0.5);
        setPosts(randomizedPosts.map(post => ({
          ...post,
          username: post.username || 'Unknown',
        })));
        randomizedPosts.forEach(post => {
          if (post.contentType === 'image' || post.contentType === 'video') cache.set(post.content, post.content);
        });
        setError('');
      } catch (error) {
        console.error('Failed to fetch feed:', error);
        setError(error.response?.data?.error || 'Failed to load feed');
      }
    };
    fetchFeed();

    socket.on('newPost', (post) => setPosts((prev) => [post, ...prev.filter(p => p._id !== post._id)]));
    socket.on('postUpdate', (updatedPost) => {
      setPosts((prev) => prev.map(p => p._id === updatedPost._id ? updatedPost : p));
    });
    socket.on('postDeleted', (postId) => setPosts((prev) => prev.filter(p => p._id !== postId)));

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const media = entry.target;
          const postId = media.dataset.postId;
          if (entry.isIntersecting) {
            setPlayingPostId(postId);
            if (media.tagName === 'VIDEO') {
              media.play().catch((err) => console.error('Play error:', err));
            }
          } else if (media.tagName === 'VIDEO') {
            media.pause();
            media.currentTime = 0; // Reset to start
          }
        });
      },
      { threshold: 0.8 }
    );

    const mediaElements = Object.values(mediaRefs.current);
    mediaElements.forEach((media) => media && observer.observe(media));

    return () => {
      mediaElements.forEach((media) => media && observer.unobserve(media));
      observer.disconnect();
      socket.off('newPost');
      socket.off('postUpdate');
      socket.off('postDeleted');
    };
  }, [token]);

  const postContent = async () => {
    if (!userId || (!caption && !file && contentType !== 'text')) {
      setError('Please provide content');
      return;
    }
    const formData = new FormData();
    formData.append('contentType', contentType);
    formData.append('caption', caption);
    if (file) formData.append('content', file);
    try {
      setUploadProgress(0);
      const { data } = await axios.post('/social/post', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
        onUploadProgress: (progressEvent) => setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total)),
      });
      socket.emit('newPost', data);
      setPosts((prev) => [data, ...prev]);
      setCaption('');
      setFile(null);
      setShowPostModal(false);
      setUploadProgress(null);
      setError('');
    } catch (error) {
      console.error('Post error:', error);
      setError(error.response?.data?.error || 'Failed to post');
      setUploadProgress(null);
    }
  };

  const likePost = async (postId) => {
    if (!playingPostId || postId !== playingPostId) return;
    try {
      const post = posts.find(p => p._id === postId);
      const action = post.likedBy?.includes(userId) ? '/social/unlike' : '/social/like';
      const { data } = await axios.post(action, { postId }, { headers: { Authorization: `Bearer ${token}` } });
      socket.emit('postUpdate', data);
    } catch (error) {
      console.error('Like error:', error);
    }
  };

  const commentPost = async (postId) => {
    if (!playingPostId || postId !== playingPostId || !comment) return;
    try {
      const { data } = await axios.post('/social/comment', { postId, comment }, { headers: { Authorization: `Bearer ${token}` } });
      const updatedPost = { ...posts.find(p => p._id === postId), comments: [...(posts.find(p => p._id === postId).comments || []), data] };
      socket.emit('postUpdate', updatedPost);
      setComment('');
    } catch (error) {
      console.error('Comment error:', error);
    }
  };

  const timeAgo = (date) => {
    const now = new Date();
    const diff = now - new Date(date);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="h-screen overflow-y-auto snap-y snap-mandatory bg-black">
      <div className="fixed bottom-20 right-4 z-20">
        <motion.button whileHover={{ scale: 1.1, rotate: 90 }} whileTap={{ scale: 0.9 }} onClick={() => setShowPostModal(true)} className="bg-primary text-white p-3 rounded-full">
          <FaPlus className="text-xl" />
        </motion.button>
      </div>
      {showPostModal && (
        <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }} className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-30">
          <div className="bg-white p-6 rounded-lg shadow-lg w-full max-w-md relative">
            {uploadProgress !== null && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-200 bg-opacity-75">
                <div className="relative w-20 h-20">
                  <svg className="w-full h-full" viewBox="0 0 36 36">
                    <path className="text-gray-300" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="3" />
                    <path className="text-primary" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray={`${uploadProgress}, 100`} />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-primary">{uploadProgress}%</span>
                </div>
              </div>
            )}
            <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="w-full p-2 mb-4 border rounded-lg">
              <option value="text">Text</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="raw">Document</option>
            </select>
            <div className="flex items-center mb-4">
              {contentType === 'text' ? (
                <textarea
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  className="flex-1 p-2 border rounded-lg focus:ring-2 focus:ring-primary"
                  placeholder="Write a caption..."
                />
              ) : (
                <input
                  type="file"
                  accept={contentType === 'image' ? 'image/*' : contentType === 'video' ? 'video/*' : contentType === 'audio' ? 'audio/*' : '*/*'}
                  onChange={(e) => setFile(e.target.files[0])}
                  className="flex-1 p-2 border rounded-lg"
                />
              )}
              <FaPaperPlane onClick={postContent} className="ml-2 text-xl text-primary cursor-pointer hover:text-secondary" />
            </div>
            {contentType !== 'text' && (
              <input
                type="text"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-primary"
                placeholder="Add a caption (optional)"
              />
            )}
            <button onClick={() => setShowPostModal(false)} className="mt-4 w-full bg-gray-300 p-2 rounded-lg hover:bg-gray-400">Cancel</button>
          </div>
        </motion.div>
      )}
      {error && <p className="text-red-500 text-center py-2 z-10 fixed top-0 w-full">{error}</p>}
      <div className="space-y-0">
        {posts.map((post) => (
          <motion.div
            key={post._id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="h-screen snap-start flex flex-col items-center justify-center text-white relative"
          >
            <div className="absolute top-4 left-0 w-full px-4 flex items-center">
              <img src={post.photo || 'https://placehold.co/40x40'} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
              <div>
                <span className="font-semibold">{post.username}</span>
                <span className="text-xs ml-2">{timeAgo(post.createdAt)}</span>
              </div>
            </div>
            {post.contentType === 'text' && <p className="text-lg">{post.content}</p>}
            {post.contentType === 'image' && (
              <img src={cache.get(post.content) || post.content} alt="Post" className="w-screen h-screen object-contain" data-post-id={post._id} ref={(el) => (mediaRefs.current[post._id] = el)} />
            )}
            {post.contentType === 'video' && (
              <video
                ref={(el) => (mediaRefs.current[post._id] = el)}
                data-post-id={post._id}
                playsInline
                loop
                src={cache.get(post.content) || post.content}
                className="w-screen h-screen object-contain"
              />
            )}
            {post.contentType === 'audio' && (
              <audio
                ref={(el) => (mediaRefs.current[post._id] = el)}
                data-post-id={post._id}
                controls
                src={post.content}
                className="w-full"
              />
            )}
            {post.contentType === 'raw' && <a href={post.content} target="_blank" rel="noopener noreferrer" className="text-blue-500">Download</a>}
            <div className="absolute bottom-4 left-4 right-4 flex justify-between items-center">
              <div className="flex space-x-4">
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaHeart
                    onClick={() => likePost(post._id)}
                    className={`text-2xl cursor-pointer ${post.likedBy?.includes(userId) ? 'text-red-500' : 'text-white'}`}
                  />
                  <span className="text-sm">{post.likes || 0}</span>
                </motion.div>
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaComment onClick={() => setShowComments(post._id)} className="text-2xl cursor-pointer text-white hover:text-primary" />
                  <span className="text-sm">{post.comments?.length || 0}</span>
                </motion.div>
                <motion.div whileHover={{ scale: 1.2 }} whileTap={{ scale: 0.9 }}>
                  <FaShare onClick={() => navigator.clipboard.writeText(`${window.location.origin}/post/${post._id}`).then(() => alert('Link copied!'))} className="text-2xl cursor-pointer text-white hover:text-primary" />
                </motion.div>
              </div>
              {post.caption && <p className="text-sm bg-black bg-opacity-50 p-2 rounded">{post.caption}</p>}
            </div>
            {showComments === post._id && (
              <motion.div
                initial={{ opacity: 0, y: 100 }}
                animate={{ opacity: 1, y: 0 }}
                className="fixed bottom-0 left-0 right-0 bg-white p-4 rounded-t-lg shadow-lg h-1/2 overflow-y-auto z-50"
              >
                <h3 className="text-lg font-bold text-primary mb-2">Comments</h3>
                {post.comments?.map((c, i) => (
                  <div key={i} className="flex items-center mb-2">
                    <img src={c.photo || 'https://placehold.co/30x30'} alt="Profile" className="w-8 h-8 rounded-full mr-2" />
                    <p className="text-sm"><span className="font-semibold">{c.username}</span> {c.comment}</p>
                  </div>
                ))}
                <div className="flex items-center mt-2">
                  <input
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    className="flex-1 p-2 border rounded-full focus:ring-2 focus:ring-primary"
                    placeholder="Add a comment..."
                  />
                  <FaPaperPlane onClick={() => commentPost(post._id)} className="ml-2 text-xl text-primary cursor-pointer hover:text-secondary" />
                </div>
              </motion.div>
            )}
          </motion.div>
        ))}
      </div>
      {showComments && <div className="fixed inset-0 bg-black bg-opacity-50" onClick={() => setShowComments(null)} />}
    </motion.div>
  );
};

export default FeedScreen;