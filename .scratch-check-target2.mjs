
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const idx = text.indexOf('const rangeLike');
console.log('rangeLike index:', idx);
const slice = text.slice(idx, idx + 300);
console.log(slice);
console.log('v15 in slice:', slice.includes('v15'));

