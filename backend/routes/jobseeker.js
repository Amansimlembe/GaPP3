const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Job = require('../models/Job');
const multer = require('multer');
const { jobMatcher } = require('../utils/jobMatcher');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

router.post('/update_cv', upload.single('cv_file'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || !req.file) return res.status(400).json({ error: 'User ID and CV file are required' });
    const cvPath = `/uploads/${req.file.filename}`;
    const user = await User.findByIdAndUpdate(userId, { cv: cvPath }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ cv: user.cv });
  } catch (error) {
    console.error('CV upload error:', error);
    res.status(500).json({ error: 'Failed to upload CV' });
  }
});

router.get('/jobs', async (req, res) => {
  try {
    const { userId } = req.query;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const internalJobs = await Job.find({ status: 'open' });
    const allJobs = internalJobs.map(job => ({
      ...job._doc,
      matchScore: jobMatcher(user, job),
    }));
    res.json({ jobs: allJobs.sort((a, b) => b.matchScore - a.matchScore) });
  } catch (error) {
    console.error('Job fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

router.post('/apply', upload.fields([{ name: 'cv_file' }, { name: 'cover_letter' }]), async (req, res) => {
  try {
    const { userId, jobId } = req.body;
    const user = await User.findById(userId);
    const job = await Job.findById(jobId);
    if (!user || !job) return res.status(404).json({ error: 'User or job not found' });
    const application = {
      userId,
      photo: user.photo,
      cv: req.files['cv_file'] ? `/uploads/${req.files['cv_file'][0].filename}` : user.cv,
      coverLetter: req.files['cover_letter'] ? `/uploads/${req.files['cover_letter'][0].filename}` : null,
    };
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