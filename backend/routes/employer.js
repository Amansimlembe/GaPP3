const express = require('express');
const Job = require('../models/Job');
const router = express.Router();

router.post('/post_job', async (req, res) => {
  const { userId, title, description, requirements, deadline, employerEmail, companyName } = req.body;
  const job = new Job({ userId, title, description, requirements, deadline, employerEmail, companyName });
  await job.save();
  res.json({ jobId: job._id });
});

module.exports = router;