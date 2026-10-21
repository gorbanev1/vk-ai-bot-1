
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
console.log('has v15 marker:', text.includes('local_structured_v15_range_day'));
console.log('count of v15:', (text.match(/local_structured_v15_range_day/g) || []).length);
console.log('dates definition at:', text.indexOf('const dates = extractExplicitDates(when'));

