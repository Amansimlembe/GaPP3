const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Job = require('../models/Job');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { jobMatcher } = require('../utils/jobMatcher');
const { router: authRoutes, authMiddleware } = require('./routes/auth');








const upload = multer({ storage: multer.memoryStorage() });

router.post('/update_cv', authMiddleware, upload.single('cv_file'), async (req, res) => {
  try {
    const { userId } = req.user; // From token
    if (!req.file) return res.status(400).json({ error: 'CV file is required' });

    const result = await cloudinary.uploader.upload_stream(
      { resource_type: 'raw', public_id: `cv_${userId}`, folder: 'gapp_cv' },
      (error, result) => {
        if (error) throw error;
        return result;
      }
    ).end(req.file.buffer);

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

router.post('/apply', authMiddleware, upload.fields([{ name: 'cv_file' }, { name: 'cover_letter' }]), async (req, res) => {
  try {
    const { userId } = req.user;
    const { jobId } = req.body;
    const user = await User.findById(userId);
    const job = await Job.findById(jobId);
    if (!user || !job) return res.status(404).json({ error: 'User or job not found' });

    let cvUrl = user.cv;
    if (req.files['cv_file']) {
      const cvResult = await cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: `cv_${userId}_${Date.now()}`, folder: 'gapp_cv' },
        (error, result) => {
          if (error) throw error;
          return result;
        }
      ).end(req.files['cv_file'][0].buffer);
      cvUrl = cvResult.secure_url;
    }

    let coverLetterUrl = null;
    if (req.files['cover_letter']) {
      const clResult = await cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: `cl_${userId}_${Date.now()}`, folder: 'gapp_cover_letters' },
        (error, result) => {
          if (error) throw error;
          return result;
        }
      ).end(req.files['cover_letter'][0].buffer);
      coverLetterUrl = clResult.secure_url;
    }

    const application = { userId, photo: user.photo, cv: cvUrl, coverLetter: coverLetterUrl };
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