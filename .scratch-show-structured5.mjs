
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
for (let i = 440; i <= 470; i++) {
  console.log(String(i + 1).padStart(5) + ': ' + lines[i]);
}

