const pdfParse = require('pdf-parse');
const fs = require('fs');

const parseCV = async (filePath) => {
  const pdfBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(pdfBuffer);
  const skills = data.text.split('\n').filter(line => line.match(/skills|experience|education/i));
  return { skills, cvPath: `/uploads/${path.basename(filePath)}` };
};

module.exports = { parseCV };