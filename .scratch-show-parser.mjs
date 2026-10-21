
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8').split(/\r?\n/);
for (let i = 960; i < 1190; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

