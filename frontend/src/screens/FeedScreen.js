import React, { useState, useEffect } from 'react';
import axios from 'axios';
import PostCard from '../components/PostCard';

const FeedScreen = () => {
  const [posts, setPosts] = useState([]);
  const [stories, setStories] = useState([]);
  const [contentType, setContentType] = useState('text');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState(null);
  const [isStory, setIsStory] = useState(false);

  useEffect(() => {
    const fetchFeed = async () => {
      try {
        const { data } = await axios.get('/social/feed');
        setPosts(data.filter(post => !post.isStory));
        setStories(data.filter(post => post.isStory && new Date(post.expiresAt) > new Date()));
      } catch (error) {
        console.error('Failed to fetch feed:', error);
      }
    };
    fetchFeed();
  }, []);

  const postContent = async () => {
    const formData = new FormData();
    const user = JSON.parse(localStorage.getItem('user'));
    formData.append('userId', user.userId);
    formData.append('contentType', contentType);
    formData.append('caption', caption);
    if (file) formData.append('content', file);
    const endpoint = isStory ? '/social/story' : '/social/post';
    await axios.post(endpoint, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
    window.location.reload();
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-4 rounded-lg shadow-md">
        <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="w-full p-2 mb-2 border rounded">
          <option value="text">Text</option>
          <option value="image">Image</option>
          <option value="video">Video</option>
        </select>
        {contentType === 'text' ? (
          <textarea value={caption} onChange={(e) => setCaption(e.target.value)} className="w-full p-2 border rounded" />
        ) : (
          <input type="file" onChange={(e) => setFile(e.target.files[0])} className="w-full p-2 border rounded" />
        )}
        <div className="flex mt-2">
          <button onClick={postContent} className="flex-1 bg-primary text-white p-2 rounded hover:bg-secondary transition duration-300">
            {isStory ? 'Post Story' : 'Post'}
          </button>
          <button onClick={() => setIsStory(!isStory)} className="ml-2 bg-accent text-white p-2 rounded hover:bg-yellow-600 transition duration-300">
            {isStory ? 'Switch to Post' : 'Switch to Story'}
          </button>
        </div>
      </div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-primary mb-2">Stories</h2>
        <div className="flex space-x-4 overflow-x-auto">
          {stories.map((story) => (
            <div key={story._id} className="flex-shrink-0 w-32">
              {story.contentType === 'text' ? (
                <div className="bg-gray-200 p-2 rounded">{story.content}</div>
              ) : story.contentType === 'image' ? (
                <img src={story.content} alt="Story" className="w-full h-32 object-cover rounded" />
              ) : (
                <video src={story.content} controls className="w-full h-32 rounded" />
              )}
            </div>
          ))}
        </div>
      </div>
      {posts.map((post) => (
        <PostCard key={post._id} post={post} />
      ))}
    </div>
  );
};

export default FeedScreen;