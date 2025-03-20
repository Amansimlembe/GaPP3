const natural = require('natural');

const matchJobs = (skills, jobs) => {
  const tokenizer = new natural.WordTokenizer();
  return jobs.map(job => {
    const skillTokens = tokenizer.tokenize(skills.join(' '));
    const reqTokens = tokenizer.tokenize(job.requirements || '');
    const matchScore = skillTokens.filter(token => reqTokens.includes(token)).length * 10;
    return { ...job._doc, matchScore };
  }).sort((a, b) => b.matchScore - a.matchScore);
};

module.exports = { matchJobs };