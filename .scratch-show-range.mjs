
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8').split(/\r?\n/);
for (let i = 430; i < 510; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}
for (let i = 700; i < 770; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

