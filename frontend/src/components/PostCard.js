import React from 'react';
import { motion } from 'framer-motion';

const PostCard = ({ post }) => (
  <motion.div whileHover={{ scale: 1.02 }} className="bg-white p-4 rounded-lg shadow-md">
    {post.contentType === 'text' ? (
      <p className="text-gray-800">{post.content}</p>
    ) : post.contentType === 'image' ? (
      <img src={post.content} alt="Post" className="w-full h-48 object-cover rounded" />
    ) : (
      <video src={post.content} controls className="w-full h-48 rounded" />
    )}
    <div className="flex space-x-4 mt-2">
      <button className="bg-secondary text-white p-2 rounded hover:bg-purple-700 transition duration-300">Like ({post.likes})</button>
      <button className="bg-gray-500 text-white p-2 rounded hover:bg-gray-600 transition duration-300">Comment ({post.comments.length})</button>
      <button className="bg-blue-500 text-white p-2 rounded hover:bg-blue-600 transition duration-300">Share ({post.shares})</button>
    </div>
  </motion.div>
);
export default PostCard;