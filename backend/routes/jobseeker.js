const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Job = require('../models/Job');
const multer = require('multer');
const path = require('path');
const { jobMatcher } = require('../utils/jobMatcher');

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, `${req.body.userId}-${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

router.post('/update_cv', upload.single('cv_file'), async (req, res) => {
  try {
    const { userId } = req.body;
    const cvPath = `/uploads/${req.file.filename}`;
    await User.findByIdAndUpdate(userId, { cv: cvPath });
    const user = await User.findById(userId);
    const internalJobs = await Job.find();
    const externalJobs = await fetchExternalJobs(); // Implement this function
    const matchedJobs = jobMatcher(user, [...internalJobs, ...externalJobs]);
    res.json({ cvPath, matchedJobs });
  } catch (error) {
    console.error('CV upload error:', error);
    res.status(500).json({ error: 'Failed to upload CV' });
  }
});

router.get('/jobs', async (req, res) => {
  const { userId } = req.query;
  const user = await User.findById(userId);
  const internalJobs = await Job.find();
  const externalJobs = await fetchExternalJobs();
  const matchedJobs = jobMatcher(user, [...internalJobs, ...externalJobs]);
  res.json({ jobs: matchedJobs });
});

router.post('/apply', async (req, res) => {
  const { userId, jobId } = req.body;
  const user = await User.findById(userId);
  const job = await Job.findById(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  // Notify employer (simplified here; add email or in-app notification logic)
  res.json({ message: 'Application submitted', applicant: { photo: user.photo, cv: user.cv, coverLetter: user.coverLetter } });
});

async function fetchExternalJobs() {
  // Placeholder: Fetch from external APIs (e.g., Indeed, LinkedIn)
  return [];
}

module.exports = router;