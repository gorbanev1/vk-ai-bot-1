
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
console.log('count v14:', (text.match(/local_structured_v14/g) || []).length);
console.log('count v15:', (text.match(/local_structured_v15_range_day/g) || []).length);

