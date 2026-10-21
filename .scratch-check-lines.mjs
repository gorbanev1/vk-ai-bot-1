
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
// find code around line 470 (index 469)
const lines = text.split(/\r?\n/);
console.log(lines.slice(466, 473).map((line, i) => (467 + i) + ': ' + line).join('\n'));

