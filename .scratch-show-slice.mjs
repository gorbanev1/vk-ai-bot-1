
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const slice = text.slice(17000, 18300);
console.log(slice);

