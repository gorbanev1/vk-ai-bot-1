
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/events/publicPostDateEvidence.js', 'utf8').split(/\r?\n/);
for (let i = 380; i < 450; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

