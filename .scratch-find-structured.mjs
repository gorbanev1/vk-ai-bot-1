
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const idx = text.indexOf('function parseStructuredEvent');
console.log('parseStructuredEvent starts at char', idx, 'line', text.slice(0, idx).split('\n').length);

