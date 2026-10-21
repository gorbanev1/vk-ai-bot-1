
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostDateEvidence.js', 'utf8');
const idx = text.indexOf('function addCalendarDays');
console.log(text.slice(idx, idx + 500));

