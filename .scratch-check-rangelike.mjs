
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const idx = text.indexOf('const rangeLike');
console.log('rangeLike at:', idx);
console.log(text.slice(idx, idx + 200));

