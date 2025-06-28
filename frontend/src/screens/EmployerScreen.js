import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FaBuilding, FaCalendar, FaPaperPlane, FaUsers, FaEye } from 'react-icons/fa';
import PropTypes from 'prop-types';
import { format } from 'date-fns';

const BASE_URL = 'https://gapp-6yc3.onrender.com';

const EmployerScreen = ({ token, userId, onToggleRole }) => {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    requirements: '',
    deadline: '',
    employerEmail: '',
    companyName: '',
    location: '',
    category: '',
  });
  const [selectedJob, setSelectedJob] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    const fetchJobs = async (pageNum = 1, append = false) => {
      setLoading(true);
      try {
        const { data } = await axios.get(`${BASE_URL}/employer/jobs`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { page: pageNum, limit: 20 },
        });
        setJobs(prev => append ? [...prev, ...(Array.isArray(data.jobs) ? data.jobs : [])] : (Array.isArray(data.jobs) ? data.jobs : []));
        setHasMore(data.hasMore);
        setError('');
      } catch (error) {
        console.error('Failed to fetch jobs:', error);
        setError('Failed to load jobs');
        setJobs([]);
      } finally {
        setLoading(false);
      }
    };
    fetchJobs(1);
  }, [token, userId]);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const postJob = async (e) => {
    e.preventDefault();
    if (!formData.title || !formData.description || !formData.companyName) {
      setError('Title, description, and company name are required');
      return;
    }
    try {
      await axios.post(`${BASE_URL}/employer/post_job`, { ...formData, userId }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setFormData({
        title: '',
        description: '',
        requirements: '',
        deadline: '',
        employerEmail: '',
        companyName: '',
        location: '',
        category: '',
      });
      setError('');
      alert('Job posted successfully');
      const { data } = await axios.get(`${BASE_URL}/employer/jobs`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { page: 1, limit: 20 },
      });
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setHasMore(data.hasMore);
    } catch (error) {
      console.error('Job post error:', error);
      setError(error.response?.data?.error || 'Failed to post job');
    }
  };

  const viewApplications = (job) => {
    setSelectedJob(job);
  };

  const loadMore = () => {
    setPage(prev => prev + 1);
    fetchJobs(page + 1, true);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="p-6 bg-gray-100 min-h-screen"
    >
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-gray-800">Manage Your Job Postings</h1>
          <button
            onClick={() => onToggleRole()}
            className="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition duration-300"
          >
            Switch to Job Seeker View
          </button>
        </div>

        {/* Job Posting Form */}
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Create New Job Posting</h2>
          <form onSubmit={postJob} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-700 mb-1">Job Title</label>
              <input
                type="text"
                name="title"
                value={formData.title}
                onChange={handleInputChange}
                placeholder="Enter job title"
                className="w-full p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
            <div>
              <label className="block text-gray-700 mb-1">Company Name</label>
              <div className="relative">
                <FaBuilding className="absolute top-3 left-3 text-gray-400" />
                <input
                  type="text"
                  name="companyName"
                  value={formData.companyName}
                  onChange={handleInputChange}
                  placeholder="Enter company name"
                  className="w-full p-2 pl-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-gray-700 mb-1">Location</label>
              <input
                type="text"
                name="location"
                value={formData.location}
                onChange={handleInputChange}
                placeholder="Enter job location (e.g., Remote, New York)"
                className="w-full p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-gray-700 mb-1">Category</label>
              <select
                name="category"
                value={formData.category}
                onChange={handleInputChange}
                className="w-full p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select Category</option>
                <option value="Engineering">Engineering</option>
                <option value="Data Science">Data Science</option>
                <option value="Marketing">Marketing</option>
                <option value="Design">Design</option>
                <option value="Finance">Finance</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-gray-700 mb-1">Description</label>
              <textarea
                name="description"
                value={formData.description}
                onChange={handleInputChange}
                placeholder="Describe the job role and responsibilities"
                className="w-full p-2 border rounded-lg h-32 focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-gray-700 mb-1">Requirements</label>
              <textarea
                name="requirements"
                value={formData.requirements}
                onChange={handleInputChange}
                placeholder="List job requirements (e.g., skills, experience)"
                className="w-full p-2 border rounded-lg h-24 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-gray-700 mb-1">Application Deadline</label>
              <div className="relative">
                <FaCalendar className="absolute top-3 left-3 text-gray-400" />
                <input
                  type="date"
                  name="deadline"
                  value={formData.deadline}
                  onChange={handleInputChange}
                  className="w-full p-2 pl-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-gray-700 mb-1">Employer Email</label>
              <input
                type="email"
                name="employerEmail"
                value={formData.employerEmail}
                onChange={handleInputChange}
                placeholder="Enter contact email"
                className="w-full p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="md:col-span-2">
              <button
                type="submit"
                className="w-full bg-blue-500 text-white p-2 rounded-lg hover:bg-blue-600 transition duration-300 flex items-center justify-center"
              >
                <FaPaperPlane className="mr-2" />
                Post Job
              </button>
            </div>
          </form>
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

        {/* Posted Jobs */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Your Posted Jobs</h2>
          {loading ? (
            <div className="text-center text-gray-600">Loading jobs...</div>
          ) : jobs.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {jobs.map((job) => (
                <motion.div
                  key={job._id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="bg-gray-50 p-4 rounded-lg shadow-sm hover:shadow-md transition-shadow duration-300"
                >
                  <h3 className="text-lg font-semibold text-gray-800">{job.title}</h3>
                  <p className="text-gray-600 mt-1">{job.companyName}</p>
                  <p className="text-gray-500 text-sm mt-1">{job.location || 'Not specified'}</p>
                  <p className="text-gray-500 text-sm mt-1">{job.category || 'General'}</p>
                  <p className="text-gray-500 text-sm mt-1">
                    Deadline: {job.deadline ? format(new Date(job.deadline), 'MMM dd, yyyy') : 'No deadline'}
                  </p>
                  <p className="text-gray-600 mt-2 line-clamp-3">{job.description}</p>
                  <div className="flex items-center mt-2">
                    <FaUsers className="text-blue-600 mr-2" />
                    <p className="text-blue-600">
                      {job.applications?.length || 0} Application{job.applications?.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => viewApplications(job)}
                    className="mt-4 w-full bg-blue-500 text-white p-2 rounded-lg hover:bg-blue-600 transition duration-300 flex items-center justify-center"
                  >
                    <FaEye className="mr-2" />
                    View Applications
                  </button>
                </motion.div>
              ))}
            </div>
          ) : (
            <p className="text-gray-600">You haven't posted any jobs yet.</p>
          )}
        </div>

        {/* Load More Button */}
        {hasMore && !loading && (
          <div className="mt-6 text-center">
            <button
              onClick={loadMore}
              className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 transition duration-300"
            >
              Load More Jobs
            </button>
          </div>
        )}

        {/* Applications Modal */}
        <AnimatePresence>
          {selectedJob && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
            >
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.8, opacity: 0 }}
                className="bg-white p-6 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto"
              >
                <h2 className="text-lg font-semibold text-gray-800 mb-4">Applications for {selectedJob.title}</h2>
                {selectedJob.applications?.length > 0 ? (
                  <div className="space-y-4">
                    {selectedJob.applications.map((app, index) => (
                      <div key={index} className="border-b pb-4">
                        <p className="text-gray-700">Applicant ID: {app.userId}</p>
                        {app.cv && (
                          <a
                            href={app.cv}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 underline"
                          >
                            View CV
                          </a>
                        )}
                        {app.coverLetter && (
                          <a
                            href={app.coverLetter}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 underline ml-4"
                          >
                            View Cover Letter
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-600">No applications yet.</p>
                )}
                <button
                  onClick={() => setSelectedJob(null)}
                  className="mt-4 w-full bg-gray-500 text-white p-2 rounded-lg hover:bg-gray-600 transition duration-300"
                >
                  Close
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
};

EmployerScreen.propTypes = {
  token: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  onToggleRole: PropTypes.func.isRequired,
};

export default EmployerScreen;