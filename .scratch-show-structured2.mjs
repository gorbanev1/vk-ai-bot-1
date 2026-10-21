
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8').split(/\r?\n/);
for (let i = 390; i < 440; i++) {
  console.log(String(i + 1).padStart(5) + ': ' + lines[i]);
}

