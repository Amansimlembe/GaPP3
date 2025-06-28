const mongoose = require('mongoose');
const jobSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  requirements: String,
  deadline: String,
  employerEmail: String,
  companyName: { type: String, required: true },
  location: String,
  category: String,
  status: { type: String, default: 'open' },
  applications: [{
    userId: String,
    photo: String,
    cv: String,
    coverLetter: String,
    appliedAt: { type: Date, default: Date.now },
  }],
  createdAt: { type: Date, default: Date.now },
});
module.exports = mongoose.model('Job', jobSchema);