
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/events/publicPostDateEvidence.js', 'utf8').split(/\r?\n/);
for (let i = 270; i < 350; i++) {
  console.log(String(i).padStart(5) + ': ' + lines[i - 1]);
}

