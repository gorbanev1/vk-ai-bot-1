
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
const idx = text.indexOf('function expandEventDateRange');
if (idx >= 0) {
  console.log('found expandEventDateRange at line', text.slice(0, idx).split('\n').length);
} else {
  console.log('expandEventDateRange not found');
}
const rangeIdx = text.indexOf('rangeLike');
console.log('rangeLike at line', text.slice(0, rangeIdx).split('\n').length);

