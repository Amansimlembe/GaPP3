import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';

const FeedScreen = ({ token, userId }) => {
  const [posts, setPosts] = useState([]);
  const [stories, setStories] = useState([]);
  const [contentType, setContentType] = useState('text');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState(null);
  const [isStory, setIsStory] = useState(false);
  const [error, setError] = useState('');
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
          const video = entry.target;
          if (entry.isIntersecting) {
            video.play();
          } else {
            video.pause();
          }
        });
      },
      { threshold: 0.5 }
    );

    document.querySelectorAll('video').forEach((video) => observer.observe(video));
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
      setError('');
    } catch (error) {
      console.error('Post error:', error);
      setError(error.response?.data?.error || 'Failed to post');
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="space-y-6 p-4 md:p-6 max-h-screen overflow-y-auto">
      <div className="bg-white p-4 rounded-lg shadow-md sticky top-0 z-10">
        <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="w-full p-2 mb-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary">
          <option value="text">Text</option>
          <option value="image">Image</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
          <option value="raw">Document</option>
        </select>
        {contentType === 'text' ? (
          <textarea value={caption} onChange={(e) => setCaption(e.target.value)} className="w-full p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary" />
        ) : (
          <input
            type="file"
            accept={contentType === 'image' ? 'image/*' : contentType === 'video' ? 'video/*' : contentType === 'audio' ? 'audio/*' : '*/*'}
            onChange={(e) => setFile(e.target.files[0])}
            className="w-full p-2 border rounded-lg"
          />
        )}
        <div className="flex mt-2">
          <button onClick={postContent} className="flex-1 bg-primary text-white p-2 rounded-lg hover:bg-secondary transition duration-300">
            {isStory ? 'Post Story' : 'Post'}
          </button>
          <button onClick={() => setIsStory(!isStory)} className="ml-2 bg-accent text-white p-2 rounded-lg hover:bg-yellow-600 transition duration-300">
            {isStory ? 'Switch to Post' : 'Switch to Story'}
          </button>
        </div>
      </div>
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-primary mb-2">Stories</h2>
        <div className="flex space-x-4 overflow-x-auto pb-2">
          {stories.map((story) => (
            <motion.div key={story._id} whileHover={{ scale: 1.05 }} className="flex-shrink-0 w-32">
              {story.contentType === 'text' ? (
                <div className="bg-gray-200 p-2 rounded text-sm">{story.content}</div>
              ) : story.contentType === 'image' ? (
                <img src={story.content} alt="Story" className="w-full h-32 object-cover rounded" />
              ) : story.contentType === 'video' ? (
                <video ref={(el) => (mediaRefs.current[story._id] = el)} onPlay={() => handleMediaPlay(story._id, 'video')} controls src={story.content} className="w-full h-32 object-cover rounded" />
              ) : story.contentType === 'audio' ? (
                <audio ref={(el) => (mediaRefs.current[story._id] = el)} onPlay={() => handleMediaPlay(story._id, 'audio')} controls src={story.content} className="w-full" />
              ) : (
                <a href={story.content} target="_blank" rel="noopener noreferrer" className="text-blue-500">Download</a>
              )}
            </motion.div>
          ))}
        </div>
      </div>
      <div className="space-y-6">
        {posts.map((post) => (
          <div key={post._id} className="bg-white p-4 rounded-lg shadow-md">
            <p>User: {post.userId}</p>
            {post.contentType === 'text' && <p>{post.content}</p>}
            {post.contentType === 'image' && <img src={post.content} alt="Post" className="max-w-full h-auto" />}
            {post.contentType === 'video' && (
              <video ref={(el) => (mediaRefs.current[post._id] = el)} onPlay={() => handleMediaPlay(post._id, 'video')} controls src={post.content} className="max-w-full h-auto" />
            )}
            {post.contentType === 'audio' && (
              <audio ref={(el) => (mediaRefs.current[post._id] = el)} onPlay={() => handleMediaPlay(post._id, 'audio')} controls src={post.content} className="w-full" />
            )}
            {post.contentType === 'raw' && <a href={post.content} target="_blank" rel="noopener noreferrer" className="text-blue-500">Download</a>}
          </div>
        ))}
      </div>
    </motion.div>
  );
};

export default FeedScreen;