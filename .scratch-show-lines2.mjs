
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
console.log('line 470 (0-based 469):', lines[469]);
console.log('line 471 (0-based 470):', lines[470]);

