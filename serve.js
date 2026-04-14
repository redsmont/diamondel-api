const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
module.exports = html;
