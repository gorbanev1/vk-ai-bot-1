
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const idx = text.indexOf('const rangeLike');
console.log('rangeLike starts at index', idx);
console.log('when extraction starts at', text.indexOf('const when = extractLabel'));

