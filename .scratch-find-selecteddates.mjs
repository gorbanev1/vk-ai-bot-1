
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const idx = text.indexOf('const selectedDates');
console.log('selectedDates at:', idx);
console.log('line:', text.slice(0, idx).split('\n').length);

