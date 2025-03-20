import React from 'react';

const PostCard = ({ post }) => (
  <div style={{ padding: 10, borderBottom: '1px solid #ccc' }}>
    {post.contentType === 'text' ? (
      <p>{post.content}</p>
    ) : (
      <img src={`https://gapp-6yc3.onrender.com${post.content}`} alt="Post" style={{ width: 200, height: 200 }} />
    )}
    <button>Like</button>
  </div>
);

export default PostCard;