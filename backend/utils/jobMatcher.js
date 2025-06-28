// In jobMatcher.js
const pdfParse = require('pdf-parse');
const jobMatcher = async (user, job) => {
  if (!user.cv) return 0;
  const response = await axios.get(user.cv, { responseType: 'arraybuffer' });
  const pdfData = await pdfParse(response.data);
  const cvText = pdfData.text.toLowerCase();
  const jobText = `${job.title} ${job.description} ${job.requirements}`.toLowerCase();
  const skills = ['javascript', 'python', 'react', 'node', 'sql']; // Example skills
  let score = 0;
  skills.forEach(skill => {
    if (cvText.includes(skill) && jobText.includes(skill)) score += 20;
  });
  return Math.min(score, 100);
};
module.exports = { jobMatcher };