
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const idx = text.indexOf('function parseStructuredEvent');
const body = text.slice(idx, idx + 2000);
console.log(body);

