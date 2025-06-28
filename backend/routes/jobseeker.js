const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Job = require('../models/Job');
const Post = require('../models/Post');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { jobMatcher } = require('../utils/jobMatcher');
const authMiddleware = require('./auth');
const axios = require('axios');

const upload = multer({ storage: multer.memoryStorage() });

router.post('/update_cv', authMiddleware, upload.single('cv_file'), async (req, res) => {
  try {
    const { userId } = req.user;
    if (!req.file) return res.status(400).json({ error: 'CV file is required' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files are allowed' });

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: `cv_${userId}_${Date.now()}`, folder: 'gapp_cv' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(req.file.buffer);
    });

    const user = await User.findByIdAndUpdate(userId, { cv: result.secure_url }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ cv: user.cv });
  } catch (error) {
    console.error('CV upload error:', error);
    res.status(500).json({ error: 'Failed to upload CV' });
  }
});

router.get('/jobs', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.user;
    const { page = 1, limit = 20, search, location, category } = req.query;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const query = { status: 'open' };
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }
    if (location) query.location = { $regex: location, $options: 'i' };
    if (category) query.category = category;

    const jobs = await Job.find(query)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const allJobs = jobs.map(job => ({
      ...job,
      matchScore: jobMatcher(user, job),
    }));

    const totalJobs = await Job.countDocuments(query);
    res.json({
      jobs: allJobs.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0)),
      hasMore: (page * limit) < totalJobs,
    });
  } catch (error) {
    console.error('Job fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

router.get('/external_jobs', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.user;
    const { page = 1, limit = 20, search, location, category } = req.query;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Example: Integrate with Indeed API (replace with actual API key and endpoint)
    const response = await axios.get('https://api.indeed.com/ads/apisearch', {
      params: {
        publisher: process.env.INDEED_API_KEY,
        q: search || (user.skills?.join(' ') || 'software'),
        l: location || '',
        format: 'json',
        v: 2,
        start: (page - 1) * limit,
        limit: parseInt(limit),
      },
    });

    const jobs = response.data.results.map(job => ({
      _id: `ext_${job.jobkey}`,
      title: job.jobtitle,
      description: job.snippet,
      companyName: job.company,
      location: job.formattedLocation,
      category: category || 'General',
      applyLink: job.url,
      postedAt: job.date,
      source: 'external',
      matchScore: jobMatcher(user, { title: job.jobtitle, description: job.snippet, requirements: '' }),
    }));

    const totalJobs = response.data.totalResults;
    res.json({
      jobs,
      hasMore: (page * limit) < totalJobs,
    });
  } catch (error) {
    console.error('External job fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch external jobs' });
  }
});

router.get('/job_posts', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.user;
    const { page = 1, limit = 20, search, location, category } = req.query;
    const user = await platingUser.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Filter for job-related posts (e.g., caption or content contains job-related keywords)
    const query = {
      contentType: { $in: ['text', 'image', 'video', 'raw'] },
      $or: [
        { caption: { $regex: 'job|position|opportunity|hiring|career', $options: 'i' } },
        { content: { $elemMatch: { $regex: 'job|position|opportunity|hiring|career', $options: 'i' } } },
      ],
    };
    if (search) {
      query.$or = [
        { caption: { $regex: search, $options: 'i' } },
        { content: { $elemMatch: { $regex: search, $options: 'i' } } },
      ];
    }
    if (location) query.location = { $regex: location, $options: 'i' };
    if (category) query.category = category;

    const posts = await Post.find(query)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const allPosts = posts.map(post => ({
      ...post,
      matchScore: jobMatcher(user, { title: post.caption || 'Job Opportunity', description: post.content.join(', '), requirements: '' }),
      applyLink: post.content.find(url => url.includes('apply')) || null,
      category: post.category || 'General',
      location: post.location || 'Not specified',
    }));

    const totalPosts = await Post.countDocuments(query);
    res.json({
      posts: allPosts.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0)),
      hasMore: (page * limit) < totalPosts,
    });
  } catch (error) {
    console.error('Job posts fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch job posts' });
  }
});

router.post('/apply', authMiddleware, upload.fields([{ name: 'cv_file' }, { name: 'cover_letter' }]), async (req, res) => {
  try {
    const { userId } = req.user;
    const { jobId } = req.body;
    const user = await User.findById(userId);
    const job = await Job.findById(jobId);
    if (!user || !job) return res.status(404).json({ error: 'User or job not found' });

    let cvUrl = user.cv;
    if (req.files['cv_file']) {
      if (req.files['cv_file'][0].mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'CV must be a PDF file' });
      }
      const cvResult = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'raw', public_id: `cv_${userId}_${Date.now()}`, folder: 'gapp_cv' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        ).end(req.files['cv_file'][0].buffer);
      });
      cvUrl = cvResult.secure_url;
    }

    let coverLetterUrl = null;
    if (req.files['cover_letter']) {
      if (req.files['cover_letter'][0].mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'Cover letter must be a PDF file' });
      }
      const clResult = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'raw', public_id: `cl_${userId}_${Date.now()}`, folder: 'gapp_cover_letters' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        ).end(req.files['cover_letter'][0].buffer);
      });
      coverLetterUrl = clResult.secure_url;
    }

    const application = { userId, photo: user.photo, cv: cvUrl, coverLetter: coverLetterUrl, appliedAt: new Date() };
    job.applications = job.applications || [];
    job.applications.push(application);
    await job.save();
    res.json({ message: 'Application submitted' });
  } catch (error) {
    console.error('Application error:', error);
    res.status(500).json({ error: 'Failed to apply' });
  }
});

module.exports = router;