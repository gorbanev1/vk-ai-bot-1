
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/events/eventValidation.js', 'utf8').split(/\r?\n/);
for (let i = 125; i < 210; i++) {
  console.log(String(i).padStart(5) + ': ' + lines[i - 1]);
}

