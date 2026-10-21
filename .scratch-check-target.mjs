
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
const target = lines[469];
console.log('target line:', target);
console.log('contains v15?', target.includes('v15'));

