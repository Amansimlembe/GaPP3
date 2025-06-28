const express = require('express');
const Job = require('../models/Job');
const authMiddleware = require('./auth');
const router = express.Router();

router.post('/post_job', authMiddleware, async (req, res) => {
  try {
    const { userId, title, description, requirements, deadline, employerEmail, companyName, location, category } = req.body;
    if (!title || !description || !companyName) {
      return res.status(400).json({ error: 'Title, description, and company name are required' });
    }
    const job = new Job({
      userId,
      title,
      description,
      requirements,
      deadline,
      employerEmail,
      companyName,
      location,
      category,
      status: 'open',
    });
    await job.save();
    res.json({ jobId: job._id });
  } catch (error) {
    console.error('Job post error:', error);
    res.status(500).json({ error: 'Failed to post job' });
  }
});

router.get('/jobs', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.user;
    const { page = 1, limit = 20 } = req.query;
    const jobs = await Job.find({ userId, status: 'open' })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();
    const totalJobs = await Job.countDocuments({ userId, status: 'open' });
    res.json({
      jobs,
      hasMore: (page * limit) < totalJobs,
    });
  } catch (error) {
    console.error('Fetch jobs error:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

module.exports = router;