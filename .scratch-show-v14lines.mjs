
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
const idx = text.indexOf('local_structured_v14');
console.log('v14 first occurrence line:', text.slice(0, idx).split('\n').length);
for (let i = 455; i <= 500; i++) {
  console.log(String(i + 1).padStart(5) + ': ' + lines[i]);
}

