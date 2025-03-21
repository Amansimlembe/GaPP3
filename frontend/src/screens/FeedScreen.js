import React, { useState, useEffect } from 'react';
import axios from 'axios';
import PostCard from '../components/PostCard';

const FeedScreen = () => {
  const [posts, setPosts] = useState([]);
  const [stories, setStories] = useState([]);
  const [content, setContent] = useState('');
  const [contentType, setContentType] = useState('text');
  const [file, setFile] = useState(null);
  const [isStory, setIsStory] = useState(false);

  useEffect(() => {
    const fetchFeed = async () => {
      const { data } = await axios.get('/social/feed');
      setPosts(data);
    };
    const fetchStories = async () => {
      const { data } = await axios.get('/social/stories');
      setStories(data);
    };
    fetchFeed();
    fetchStories();
  }, []);

  const postContent = async () => {
    const formData = new FormData();
    formData.append('userId', JSON.parse(localStorage.getItem('user')).userId);
    formData.append('contentType', contentType);
    if (contentType === 'text') formData.append('content', content);
    else formData.append('content', file);
    const endpoint = isStory ? '/social/story' : '/social/post';
    const { data } = await axios.post(endpoint, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
    if (isStory) setStories((prev) => [data, ...prev]);
    else setPosts((prev) => [data, ...prev]);
    setContent('');
    setFile(null);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-4 rounded-lg shadow-md">
        <h2 className="text-xl font-bold text-primary mb-4">{isStory ? 'Post a Story' : 'Post to Feed'}</h2>
        <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="w-full p-3 mb-4 border rounded">
          <option value="text">Text</option>
          <option value="image">Image</option>
          <option value="video">Video</option>
        </select>
        {contentType === 'text' ? (
          <textarea value={content} onChange={(e) => setContent(e.target.value)} className="w-full p-3 mb-4 border rounded" />
        ) : (
          <input type="file" accept={contentType === 'image' ? 'image/*' : 'video/*'} onChange={(e) => setFile(e.target.files[0])} className="w-full p-3 mb-4 border rounded" />
        )}
        <label className="flex items-center mb-4">
          <input type="checkbox" checked={isStory} onChange={(e) => setIsStory(e.target.checked)} className="mr-2" />
          Post as Story (24-hour)
        </label>
        <button onClick={postContent} className="w-full bg-primary text-white p-3 rounded hover:bg-secondary transition duration-300">Post</button>
      </div>
      <div className="flex space-x-4">
        <div className="w-1/4">
          <h3 className="text-lg font-bold text-primary mb-2">Stories</h3>
          {stories.map((story) => (
            <div key={story._id} className="mb-2">
              {story.contentType === 'text' ? (
                <p className="text-gray-800">{story.content}</p>
              ) : (
                <video src={`https://gapp-6yc3.onrender.com${story.content}`} controls className="w-full h-20 object-cover rounded" />
              )}
            </div>
          ))}
        </div>
        <div className="w-3/4">
          <h3 className="text-lg font-bold text-primary mb-2">Feed</h3>
          {posts.map((post) => (
            <PostCard key={post._id} post={post} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default FeedScreen;