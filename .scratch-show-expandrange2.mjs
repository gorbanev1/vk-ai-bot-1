
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/eventDuplicateResolution.js', 'utf8');
const idx = text.indexOf('function expandRange');
console.log(text.slice(idx, idx + 500));

