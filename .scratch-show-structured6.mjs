
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
for (let i = 420; i <= 478; i++) {
  console.log(String(i).padStart(5) + ': ' + lines[i - 1]);
}

