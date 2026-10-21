
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const idx = text.indexOf('const rangeLike');
console.log('v15 exists:', text.includes('local_structured_v15_range_day'));
console.log('v15 index:', text.indexOf('local_structured_v15_range_day'));
console.log('rangeLike index:', idx);

