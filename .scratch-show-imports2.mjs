
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const importBlock = text.slice(0, text.indexOf('function scoreEventDateMention'));
console.log(importBlock);

