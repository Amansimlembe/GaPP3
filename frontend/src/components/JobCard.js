import React from 'react';
import { motion } from 'framer-motion';

const JobCard = ({ job, onApply }) => (
  <motion.div
    whileHover={{ scale: 1.05, boxShadow: '0 10px 20px rgba(0,0,0,0.1)' }}
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.3 }}
    className="bg-white p-4 rounded-lg shadow-md"
  >
    <h3 className="text-lg font-semibold text-primary">{job.title} ({job.matchScore}% Match)</h3>
    <p className="text-gray-600 mt-2">{job.description}</p>
    <button
      onClick={onApply}
      className="mt-4 bg-accent text-white p-2 rounded-lg hover:bg-yellow-600 transition duration-300 w-full"
    >
      Apply
    </button>
  </motion.div>
);

export default JobCard;