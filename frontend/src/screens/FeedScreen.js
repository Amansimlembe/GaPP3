import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { FaPlus, FaPaperPlane } from 'react-icons/fa'; // Added FaPaperPlane import

const FeedScreen = ({ token, userId }) => {
  const [posts, setPosts] = useState([]);
  const [stories, setStories] = useState([]);
  const [contentType, setContentType] = useState('text');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState(null);
  const [isStory, setIsStory] = useState(false);
  const [error, setError] = useState('');
  const [showPostModal, setShowPostModal] = useState(false);
  const mediaRefs = useRef({});

  useEffect(() => {
    const fetchFeed = async () => {
      try {
        const { data } = await axios.get('/social/feed', {
          headers: { Authorization: `Bearer ${token}` },
        });
        setPosts(data.filter(post => !post.isStory));
        setStories(data.filter(post => post.isStory && new Date(post.expiresAt) > new Date()));
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
    if (!userId || (!caption && !file)) {
      setError('Please provide content');
      return;
    }
    const formData = new FormData();
    formData.append('contentType', contentType);
    formData.append('caption', caption);
    if (file) formData.append('content', file);
    const endpoint = isStory ? '/social/story' : '/social/post';
    try {
      const { data } = await axios.post(endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${token}` },
      });
      if (isStory) setStories([data, ...stories]);
      else setPosts([data, ...posts]);
      setCaption('');
      setFile(null);
      setShowPostModal(false);
      setError('');
    } catch (error) {
      console.error('Post error:', error);
      setError(error.response?.data?.error || 'Failed to post');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="relative h-screen overflow-y-auto snap-y snap-mandatory md:ml-64 p-4 md:p-6"
    >
      <div className="fixed bottom-8 right-8 z-20">
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => setShowPostModal(true)}
          className="bg-primary text-white p-4 md:p-6 rounded-full shadow-lg"
        >
          <FaPlus className="text-2xl md:text-3xl" />
        </motion.button>
      </div>
      {showPostModal && (
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 50 }}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30"
        >
          <div className="bg-white p-4 md:p-6 rounded-lg shadow-lg w-11/12 max-w-md">
            <select
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              className="w-full p-2 mb-4 border rounded-lg font-sans text-base md:text-lg"
            >
              <option value="text">Text</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="raw">Document</option>
            </select>
            {contentType === 'text' ? (
              <div className="flex items-center">
                <textarea
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  className="flex-1 p-2 border rounded-lg font-sans text-base md:text-lg"
                  placeholder="What's on your mind?"
                />
                <FaPaperPlane
                  onClick={postContent}
                  className="ml-2 text-2xl md:text-3xl text-primary cursor-pointer hover:text-secondary"
                />
              </div>
            ) : (
              <div className="flex items-center">
                <input
                  type="file"
                  accept={contentType === 'image' ? 'image/*' : contentType === 'video' ? 'video/*' : contentType === 'audio' ? 'audio/*' : '*/*'}
                  onChange={(e) => setFile(e.target.files[0])}
                  className="flex-1 p-2 border rounded-lg text-sm md:text-base"
                />
                <FaPaperPlane
                  onClick={postContent}
                  className="ml-2 text-2xl md:text-3xl text-primary cursor-pointer hover:text-secondary"
                />
              </div>
            )}
            <button onClick={() => setShowPostModal(false)} className="mt-4 w-full bg-gray-300 p-2 rounded-lg font-sans text-base md:text-lg">
              Cancel
            </button>
          </div>
        </motion.div>
      )}
      {error && <p className="text-red-500 text-center py-2 font-sans text-base md:text-lg">{error}</p>}
      <div className="space-y-0">
        {posts.map((post) => (
          <div key={post._id} className="h-screen snap-start flex items-center justify-center bg-black text-white">
            <div className="w-full max-w-md p-4">
              <p className="text-sm md:text-base font-sans mb-2">@{post.userId}</p>
              {post.contentType === 'text' && <p className="text-lg md:text-xl font-sans">{post.content}</p>}
              {post.contentType === 'image' && <img src={post.content} alt="Post" className="w-full h-auto rounded-lg" />}
              {post.contentType === 'video' && (
                <video
                  ref={(el) => (mediaRefs.current[post._id] = el)}
                  onPlay={() => handleMediaPlay(post._id, 'video')}
                  controls
                  src={post.content}
                  className="w-full h-auto rounded-lg"
                />
              )}
              {post.contentType === 'audio' && (
                <audio
                  ref={(el) => (mediaRefs.current[post._id] = el)}
                  onPlay={() => handleMediaPlay(post._id, 'audio')}
                  controls
                  src={post.content}
                  className="w-full"
                />
              )}
              {post.contentType === 'raw' && (
                <a href={post.content} target="_blank" rel="noopener noreferrer" className="text-blue-500 font-sans text-base md:text-lg">
                  Download Document
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
};

export default FeedScreen;