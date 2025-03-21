const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Job = require('../models/Job');
const multer = require('multer');
const { jobMatcher } = require('../utils/jobMatcher');
const axios = require('axios');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// Upload CV
router.post('/update_cv', upload.single('cv_file'), async (req, res) => {
  try {
    const { userId } = req.body;
    const cvPath = `/uploads/${req.file.filename}`;
    const user = await User.findByIdAndUpdate(userId, { cv: cvPath }, { new: true });
    res.json({ cv: user.cv });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload CV' });
  }
});

// Get matched jobs (internal + external)
router.get('/jobs', async (req, res) => {
  try {
    const { userId } = req.query;
    const user = await User.findById(userId);
    const internalJobs = await Job.find({ status: 'open' });
    const externalJobs = await axios.get('https://api.example.com/jobs'); // Replace with real external API
    const allJobs = [...internalJobs, ...externalJobs.data].map(job => ({
      ...job._doc || job,
      matchScore: jobMatcher(user, job),
    }));
    res.json({ jobs: allJobs.sort((a, b) => b.matchScore - a.matchScore) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// Apply to job
router.post('/apply', upload.fields([{ name: 'cv_file' }, { name: 'cover_letter' }]), async (req, res) => {
  try {
    const { userId, jobId } = req.body;
    const user = await User.findById(userId);
    const job = await Job.findById(jobId);
    const application = {
      userId,
      photo: user.photo,
      cv: req.files['cv_file'] ? `/uploads/${req.files['cv_file'][0].filename}` : user.cv,
      coverLetter: req.files['cover_letter'] ? `/uploads/${req.files['cover_letter'][0].filename}` : null,
    };
    job.applications.push(application);
    await job.save();
    res.json({ message: 'Application submitted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to apply' });
  }
});

module.exports = router;