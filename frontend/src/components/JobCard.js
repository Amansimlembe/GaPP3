import React from 'react';
import { motion } from 'framer-motion';

const JobCard = ({ job }) => (
  <motion.div
    whileHover={{ scale: 1.05 }}
    className="bg-white p-4 rounded-lg shadow-md"
  >
    <h3 className="text-lg font-semibold text-primary">{job.title} ({job.matchScore}% Match)</h3>
    <p className="text-gray-600">{job.description}</p>
    <button className="mt-2 bg-accent text-white p-2 rounded hover:bg-yellow-600 transition duration-300">
      Apply
    </button>
  </motion.div>
);

export default JobCard;