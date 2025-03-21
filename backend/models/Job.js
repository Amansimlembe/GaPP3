const mongoose = require('mongoose');
const jobSchema = new mongoose.Schema({
  userId: String,
  title: String,
  description: String,
  requirements: String,
  deadline: String,
  employerEmail: String,
  companyName: String,
  status: { type: String, default: 'open' },
  applications: [{
    userId: String,
    photo: String,
    cv: String,
    coverLetter: String,
  }],
});
module.exports = mongoose.model('Job', jobSchema);