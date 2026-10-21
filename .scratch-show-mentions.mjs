
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/events/publicPostDateEvidence.js', 'utf8').split(/\r?\n/);
for (let i = 330; i <= 385; i++) {
  console.log(String(i).padStart(5) + ': ' + lines[i - 1]);
}

