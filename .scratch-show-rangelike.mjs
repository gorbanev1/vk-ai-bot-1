
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
// Locate the block around rangeLike usage
const idx = text.indexOf('const rangeLike');
console.log(text.slice(idx, idx + 1200));

