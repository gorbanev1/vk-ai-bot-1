
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
const idx = text.indexOf('function addCalendarDays');
const hasAdd = idx >= 0;
console.log('has addCalendarDays:', hasAdd);
if (hasAdd) console.log('at line', text.slice(0, idx).split('\n').length);
const imports = text.slice(0, text.indexOf('function scoreEventDateMention'));
console.log(imports.split('\n').filter(l => l.includes('from')).join('\n'));

