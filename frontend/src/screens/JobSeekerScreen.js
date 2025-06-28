import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaSearch, FaSort, FaFilter, FaFileUpload, FaExternalLinkAlt, FaComment } from 'react-icons/fa';
import PropTypes from 'prop-types';
import { format } from 'date-fns';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const JobSeekerScreen = ({ token, userId, onToggleRole }) => {
  const [jobs, setJobs] = useState([]);
  const [posts, setPosts] = useState([]);
  const [cvFile, setCvFile] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOption, setSortOption] = useState('matchScore');
  const [filterLocation, setFilterLocation] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const fetchJobsAndPosts = useCallback(async (pageNum = 1, append = false) => {
    setLoading(true);
    try {
      // Fetch internal jobs
      const { data: internalData } = await axios.get(`${BASE_URL}/jobseeker/jobs`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, page: pageNum, limit: 20, search: searchTerm, location: filterLocation, category: filterCategory },
      });

      // Fetch external jobs
      const { data: externalData } = await axios.get(`${BASE_URL}/jobseeker/external_jobs`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, page: pageNum, limit: 20, search: searchTerm, location: filterLocation, category: filterCategory },
      });

      // Fetch job-related posts
      const { data: postData } = await axios.get(`${BASE_URL}/jobseeker/job_posts`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { userId, page: pageNum, limit: 20, search: searchTerm, location: filterLocation, category: filterCategory },
      });

      // Combine and deduplicate jobs and posts
      const allJobs = [
        ...(internalData.jobs || []).map(job => ({ ...job, source: 'internal' })),
        ...(externalData.jobs || []).map(job => ({ ...job, source: 'external' })),
        ...(postData.posts || []).map(post => ({
          _id: post._id,
          title: post.caption || 'Job Opportunity',
          description: post.content.join(', '),
          companyName: post.username,
          location: post.location || 'Not specified',
          category: post.category || 'General',
          matchScore: post.matchScore || 0,
          applyLink: post.applyLink || null,
          postedAt: post.createdAt,
          source: 'post',
          comments: post.comments,
        })),
      ].reduce((unique, job) => {
        return unique.some(u => u._id === job._id) ? unique : [...unique, job];
      }, []);

      setJobs(prev => append ? [...prev, ...allJobs] : allJobs);
      setHasMore(allJobs.length === 20); // Assume 20 is the page limit
      setError('');
    } catch (error) {
      console.error('Failed to fetch jobs/posts:', error);
      setError('Failed to fetch jobs or posts. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [token, userId, searchTerm, filterLocation, filterCategory]);

  useEffect(() => {
    if (userId) fetchJobsAndPosts(1);
  }, [userId, fetchJobsAndPosts]);

  const handleCvUpload = async () => {
    if (!cvFile) {
      setError('Please select a PDF CV file');
      return;
    }
    if (cvFile.type !== 'application/pdf') {
      setError('Only PDF files are allowed');
      return;
    }
    setIsUploading(true);
    const formData = new FormData();
    formData.append('cv_file', cvFile);
    formData.append('userId', userId);
    try {
      await axios.post(`${BASE_URL}/jobseeker/update_cv`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          Authorization: `Bearer ${token}`,
        },
      });
      setCvFile(null);
      setError('');
      alert('CV uploaded successfully');
      fetchJobsAndPosts(1); // Refresh jobs and posts to update match scores
    } catch (error) {
      console.error('CV upload error:', error);
      setError(error.response?.data?.error || 'Failed to upload CV');
    } finally {
      setIsUploading(false);
    }
  };

  const handleApply = async (job) => {
    if (job.source === 'external' || job.source === 'post') {
      if (job.applyLink) window.open(job.applyLink, '_blank');
      else setError('No application link available for this job/post');
      return;
    }
    try {
      const formData = new FormData();
      formData.append('jobId', job._id);
      formData.append('userId', userId);
      await axios.post(`${BASE_URL}/jobseeker/apply`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          Authorization: `Bearer ${token}`,
        },
      });
      alert('Application submitted successfully');
    } catch (error) {
      console.error('Application error:', error);
      setError(error.response?.data?.error || 'Failed to apply for job');
    }
  };

  const loadMore = () => {
    setPage(prev => prev + 1);
    fetchJobsAndPosts(page + 1, true);
  };

  const filteredJobs = jobs.sort((a, b) => {
    if (sortOption === 'matchScore') return (b.matchScore || 0) - (a.matchScore || 0);
    if (sortOption === 'date') return new Date(b.createdAt || b.postedAt || 0) - new Date(a.createdAt || a.postedAt || 0);
    return a.title.localeCompare(b.title);
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="p-6 bg-gray-100 min-h-screen"
    >
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-gray-800">Find Your Next Job</h1>
          <button
            onClick={() => onToggleRole()}
            className="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition duration-300"
          >
            Switch to Employer View
          </button>
        </div>

        {/* CV Upload Section */}
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Upload Your CV (PDF)</h2>
          <div className="flex items-center space-x-4">
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setCvFile(e.target.files[0])}
              className="p-2 border rounded-lg flex-1"
            />
            <button
              onClick={handleCvUpload}
              disabled={isUploading}
              className={`flex items-center px-4 py-2 rounded-lg transition duration-300 ${
                isUploading ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-500 text-white hover:bg-blue-600'
              }`}
            >
              <FaFileUpload className="mr-2" />
              {isUploading ? 'Uploading...' : 'Upload CV'}
            </button>
          </div>
        </div>

        {/* Search and Filter Section */}
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <FaSearch className="absolute top-3 left-3 text-gray-400" />
              <input
                type="text"
                placeholder="Search jobs by title or description..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full p-2 pl-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center space-x-4">
              <div className="flex items-center">
                <FaFilter className="mr-2 text-gray-600" />
                <input
                  type="text"
                  placeholder="Filter by location..."
                  value={filterLocation}
                  onChange={(e) => setFilterLocation(e.target.value)}
                  className="p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex items-center">
                <FaFilter className="mr-2 text-gray-600" />
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  className="p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All Categories</option>
                  <option value="Engineering">Engineering</option>
                  <option value="Data Science">Data Science</option>
                  <option value="Marketing">Marketing</option>
                  <option value="Design">Design</option>
                  <option value="Finance">Finance</option>
                </select>
              </div>
              <div className="flex items-center">
                <FaSort className="mr-2 text-gray-600" />
                <select
                  value={sortOption}
                  onChange={(e) => setSortOption(e.target.value)}
                  className="p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="matchScore">Sort by Match Score</option>
                  <option value="date">Sort by Date</option>
                  <option value="title">Sort by Title</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Error Message */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="bg-red-100 text-red-700 p-4 rounded-lg mb-6"
            >
              {error}
              <button
                onClick={() => setError('')}
                className="ml-4 text-sm text-red-900 underline"
              >
                Dismiss
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Jobs and Posts List */}
        {loading && page === 1 ? (
          <div className="text-center text-gray-600">Loading jobs and posts...</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredJobs.length > 0 ? (
              filteredJobs.map((job) => (
                <motion.div
                  key={job._id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="bg-white p-6 rounded-lg shadow-md hover:shadow-lg transition-shadow duration-300"
                >
                  <h3 className="text-lg font-semibold text-gray-800">{job.title}</h3>
                  <p className="text-gray-600 mt-1">{job.companyName}</p>
                  <p className="text-gray-500 text-sm mt-1">{job.location || 'Not specified'}</p>
                  <p className="text-gray-500 text-sm mt-1">{job.category || 'General'}</p>
                  <p className="text-gray-500 text-sm mt-1">
                    Posted: {format(new Date(job.createdAt || job.postedAt || new Date()), 'MMM dd, yyyy')}
                  </p>
                  <p className="text-gray-600 mt-2 line-clamp-3">{job.description}</p>
                  {job.matchScore && (
                    <p className="text-green-600 mt-2">Match Score: {Math.round(job.matchScore)}%</p>
                  )}
                  {job.source === 'post' && job.comments?.length > 0 && (
                    <p className="text-blue-600 mt-2 flex items-center">
                      <FaComment className="mr-2" />
                      {job.comments.length} Comment{job.comments.length !== 1 ? 's' : ''}
                    </p>
                  )}
                  <button
                    onClick={() => handleApply(job)}
                    className="mt-4 w-full bg-blue-500 text-white p-2 rounded-lg hover:bg-blue-600 transition duration-300 flex items-center justify-center"
                  >
                    {job.source === 'external' || job.source === 'post' ? (
                      <>
                        Apply Externally <FaExternalLinkAlt className="ml-2" />
                      </>
                    ) : (
                      'Apply Now'
                    )}
                  </button>
                </motion.div>
              ))
            ) : (
              <p className="text-gray-600 col-span-full text-center">No jobs or posts found matching your criteria.</p>
            )}
          </div>
        )}

        {/* Load More Button */}
        {hasMore && !loading && (
          <div className="mt-6 text-center">
            <button
              onClick={loadMore}
              className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 transition duration-300"
            >
              Load More
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
};

JobSeekerScreen.propTypes = {
  token: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  onToggleRole: PropTypes.func.isRequired,
};

export default JobSeekerScreen;