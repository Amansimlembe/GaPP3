import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { FaPlus, FaPaperPlane, FaHeart, FaComment, FaShare } from 'react-icons/fa';

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
        const { data } = await axios.get('/social/feed', {
          headers: { Authorization: `Bearer ${token}` },
        });
        setPosts(data.filter(post => !post.isStory));
        setError('');
      } catch (error) {
        console.error('Failed to fetch feed:', error);
        setError(error.response?.data?.error || 'Failed to load feed');
      }
    };
    fetchFeed();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const media = entry.target;
          if (entry.isIntersecting) {
            media.play();
          } else {
            media.pause();
          }
        });
      },
      { threshold: 0.8 }
    );

    document.querySelectorAll('video, audio').forEach((media) => observer.observe(media));
    return () => observer.disconnect();
  }, [token]);

  const handleMediaPlay = (id, type) => {
    Object.keys(mediaRefs.current).forEach((key) => {
      if (key !== id && mediaRefs.current[key]) {
        if (type === 'video' && mediaRefs.current[key].tagName === 'VIDEO') mediaRefs.current[key].pause();
        if (type === 'audio' && mediaRefs.current[key].tagName === 'AUDIO') mediaRefs.current[key].pause();
      }
    });
  };

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
      const { data } = await axios.post('/social/post', formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      setPosts([data, ...posts]);
      setCaption('');
      setFile(null);
      setShowPostModal(false);
      setError('');
    } catch (error) {
      console.error('Post error:', error);
      setError(error.response?.data?.error || 'Failed to post');
    }
  };

  const likePost = async (postId) => {
    try {
      await axios.post('/social/like', { postId }, { headers: { Authorization: `Bearer ${token}` } });
      setPosts(posts.map(post => post._id === postId ? { ...post, likes: (post.likes || 0) + 1 } : post));
    } catch (error) {
      console.error('Like error:', error);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="h-screen overflow-y-auto snap-y snap-mandatory">
      <div className="fixed bottom-16 right-4 z-20">
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => setShowPostModal(true)}
          className="bg-primary text-white p-4 rounded-full shadow-lg"
        >
          <FaPlus className="text-2xl" />
        </motion.button>
      </div>
      {showPostModal && (
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 50 }}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30"
        >
          <div className="bg-white p-6 rounded-lg shadow-lg w-full max-w-md">
            <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="w-full p-2 mb-4 border rounded-lg">
              <option value="text">Text</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="raw">Document</option>
            </select>
            <div className="relative flex items-center">
              {contentType === 'text' ? (
                <textarea
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  className="flex-1 p-2 border rounded-lg pr-10"
                  placeholder="Write a caption..."
                />
              ) : (
                <input
                  type="file"
                  accept={contentType === 'image' ? 'image/*' : contentType === 'video' ? 'video/*' : contentType === 'audio' ? 'audio/*' : '*/*'}
                  onChange={(e) => setFile(e.target.files[0])}
                  className="flex-1 p-2 border rounded-lg pr-10"
                />
              )}
              <FaPaperPlane onClick={postContent} className="absolute right-3 text-xl text-primary cursor-pointer hover:text-secondary" />
            </div>
            {contentType !== 'text' && (
              <input
                type="text"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                className="w-full p-2 mt-2 border rounded-lg"
                placeholder="Add a caption (optional)"
              />
            )}
            <button onClick={() => setShowPostModal(false)} className="mt-4 w-full bg-gray-300 p-2 rounded-lg">Cancel</button>
          </div>
        </motion.div>
      )}
      {error && <p className="text-red-500 text-center py-2">{error}</p>}
      <div className="space-y-4 p-4">
        {posts.map((post) => (
          <div key={post._id} className="bg-white rounded-lg shadow-md p-4 snap-start">
            <div className="flex items-center mb-2">
              <img src={post.photo || 'https://via.placeholder.com/40'} alt="Profile" className="w-10 h-10 rounded-full mr-2" />
              <span className="font-semibold">{post.username || post.userId}</span>
            </div>
            {post.contentType === 'text' && <p className="text-lg mb-2">{post.content}</p>}
            {post.contentType === 'image' && <img src={post.content} alt="Post" className="w-full h-auto rounded-lg mb-2" />}
            {post.contentType === 'video' && (
              <video
                ref={(el) => (mediaRefs.current[post._id] = el)}
                onPlay={() => handleMediaPlay(post._id, 'video')}
                controls
                src={post.content}
                className="w-full h-auto rounded-lg mb-2"
              />
            )}
            {post.contentType === 'audio' && (
              <audio
                ref={(el) => (mediaRefs.current[post._id] = el)}
                onPlay={() => handleMediaPlay(post._id, 'audio')}
                controls
                src={post.content}
                className="w-full mb-2"
              />
            )}
            {post.contentType === 'raw' && <a href={post.content} target="_blank" rel="noopener noreferrer" className="text-blue-500 mb-2">Download</a>}
            {post.caption && <p className="text-sm text-gray-600 mb-2">{post.caption}</p>}
            <div className="flex space-x-4">
              <FaHeart onClick={() => likePost(post._id)} className="text-xl cursor-pointer hover:text-red-500" />
              <span>{post.likes || 0}</span>
              <FaComment className="text-xl cursor-pointer hover:text-primary" />
              <FaShare className="text-xl cursor-pointer hover:text-primary" />
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
};

export default FeedScreen;