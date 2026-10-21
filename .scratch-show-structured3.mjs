
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
for (let i = 415; i <= 440; i++) {
  console.log(String(i).padStart(5) + ': ' + lines[i - 1]);
}
// find expand range mention in local parser
const idx = text.indexOf('expand');
console.log('expand idx:', idx);

