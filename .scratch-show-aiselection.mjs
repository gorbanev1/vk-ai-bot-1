
import fs from 'node:fs';
const text = fs.readFileSync('src/app/botApplication.js', 'utf8');
const idx = text.indexOf('aiRawCount');
console.log('idx:', idx);
console.log(text.slice(Math.max(0, idx - 5000), idx + 3000));

