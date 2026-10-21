
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
console.log(text.slice(16600, 17600));

