import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPlus, FaPaperPlane, FaHeart, FaComment, FaShare } from 'react-icons/fa';
import io from 'socket.io-client';

const socket = io('https://gapp-6yc3.onrender.com');

const FeedScreen = ({ token, userId }) => {
  const [posts, setPosts] = useState([]);
  const [contentType, setContentType] = useState('text');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState(null);
  const [showPostModal, setShowPostModal] = useState(false);
  const [error, setError] = useState('');
  const mediaRefs = useRef({});

  useEffect(() => {
   const fetchFeed = async () => {
  try {
    const { data } = await axios.get('/social/feed', { headers: { Authorization: `Bearer ${token}` } });
    setPosts(data.map(post => ({ ...post, username: post.username || 'Unknown' })));
  } catch (error) {
    console.error('Failed to fetch feed:', error);
    setError('Failed to load feed');
  }
};

    socket.on('newPost', (post) => setPosts((prev) => [post, ...prev]));
    socket.on('postUpdate', (updatedPost) => setPosts((prev) => prev.map(p => p._id === updatedPost._id ? updatedPost : p)));

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const media = entry.target;
          if (entry.isIntersecting) {
            media.play().catch(() => {});
          } else {
            media.pause();
          }
        });
      },
      { threshold: 0.5 }
    );

    return () => {
      socket.off('newPost');
      socket.off('postUpdate');
      Object.values(mediaRefs.current).forEach(media => observer.unobserve(media));
      observer.disconnect();
    };
  }, [token]);

  useEffect(() => {
    const currentMediaRefs = mediaRefs.current;
    Object.keys(currentMediaRefs).forEach(postId => {
      const media = currentMediaRefs[postId];
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              media.play().catch(() => {});
            } else {
              media.pause();
            }
          });
        },
        { threshold: 0.5 }
      );
      observer.observe(media);
      return () => observer.unobserve(media);
    });
  }, [posts]);

  const postContent = async () => {
    const formData = new FormData();
    formData.append('contentType', contentType);
    formData.append('caption', caption);
    if (file) formData.append('content', file);
    try {
      const { data } = await axios.post('/social/post', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      socket.emit('newPost', data);
      setPosts((prev) => [data, ...prev]);
      setCaption('');
      setFile(null);
      setShowPostModal(false);
    } catch (error) {
      console.error('Post error:', error);
      setError('Failed to post');
    }
  };

  const likePost = async (postId) => {
    try {
      const { data } = await axios.post('/social/like', { postId }, { headers: { Authorization: `Bearer ${token}` } });
      socket.emit('postUpdate', data);
    } catch (error) {
      console.error('Like error:', error);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-screen overflow-y-auto snap-y snap-mandatory bg-black">
      <div className="fixed bottom-20 right-4 z-20">
        <motion.button whileHover={{ scale: 1.1 }} onClick={() => setShowPostModal(true)} className="bg-primary text-white p-2 rounded-full">
          <FaPlus className="text-3xl" />
        </motion.button>
      </div>
      {showPostModal && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-30">
          <div className="bg-white p-6 rounded-lg w-full max-w-md">
            <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="w-full p-2 mb-4 border rounded-lg">
              <option value="text">Text</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
            </select>
            <input
              type={contentType === 'text' ? 'text' : 'file'}
              onChange={(e) => contentType === 'text' ? setCaption(e.target.value) : setFile(e.target.files[0])}
              className="w-full p-2 mb-4 border rounded-lg"
            />
            {contentType !== 'text' && (
              <input
                type="text"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                className="w-full p-2 mb-4 border rounded-lg"
                placeholder="Add a caption"
              />
            )}
            <div className="flex space-x-2">
              <button onClick={postContent} className="bg-primary text-white p-2 rounded-lg flex-1">Post</button>
              <button onClick={() => setShowPostModal(false)} className="bg-gray-300 p-2 rounded-lg flex-1">Cancel</button>
            </div>
          </div>
        </motion.div>
      )}
      {error && <p className="text-red-500 text-center py-2">{error}</p>}
      <div className="space-y-0">
        {posts.map((post) => (
          <motion.div
            key={post._id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-screen snap-start flex flex-col items-center justify-center text-white relative"
          >
            <div className="absolute top-4 left-4 flex items-center">
              <img src={post.photo || 'https://via.placeholder.com/40'} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
              <span className="font-semibold">{post.username || 'Unknown'}</span>
            </div>
            {post.contentType === 'video' && (
              <video
                ref={(el) => { if (el) mediaRefs.current[post._id] = el; }}
                src={post.content}
                className="w-screen h-screen object-contain"
                autoPlay
                muted
                loop
              />
            )}
            {post.contentType === 'image' && (
              <img
                src={post.content}
                alt="Post"
                className="w-screen h-screen object-contain"
              />
            )}
            {post.contentType === 'text' && <p className="text-lg">{post.content}</p>}
            <div className="absolute bottom-10 right-4 flex flex-col space-y-4">
              <FaHeart onClick={() => likePost(post._id)} className="text-3xl cursor-pointer text-white" />
              <FaComment className="text-3xl cursor-pointer text-white" />
              <FaShare className="text-3xl cursor-pointer text-white" />
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
};

export default FeedScreen;