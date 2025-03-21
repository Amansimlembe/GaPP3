import React from 'react';
import { motion } from 'framer-motion';

const PostCard = ({ post }) => (
  <motion.div
    whileHover={{ scale: 1.02 }}
    className="bg-white p-4 rounded-lg shadow-md"
  >
    {post.contentType === 'text' ? (
      <p className="text-gray-800">{post.content}</p>
    ) : (
      <img
        src={`https://gapp-6yc3.onrender.com${post.content}`}
        alt="Post"
        className="w-full h-48 object-cover rounded"
      />
    )}
    <button className="mt-2 bg-secondary text-white p-2 rounded hover:bg-purple-700 transition duration-300">
      Like
    </button>
  </motion.div>
);

export default PostCard;