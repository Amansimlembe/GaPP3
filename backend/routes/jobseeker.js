const express = require('express');
const multer = require('multer');
const User = require('../models/User');
const Job = require('../models/Job');
const { parseCV } = require('../utils/cvParser');
const { matchJobs } = require('../utils/jobMatcher');
const router = express.Router();

const upload = multer({ dest: 'uploads/' });

router.post('/update_cv', upload.single('cv_file'), async (req, res) => {
  const { userId } = req.body;
  const { skills, cvPath } = await parseCV(req.file.path);
  await User.updateOne({ _id: userId }, { cv: cvPath, skills });
  res.json({ message: 'CV updated', skills });
});

router.get('/jobs', async (req, res) => {
  const { userId } = req.query;
  const user = await User.findById(userId);
  const jobs = await Job.find({ status: 'active' });
  const matchedJobs = matchJobs(user.skills, jobs);
  res.json({ jobs: matchedJobs });
});

module.exports = router;