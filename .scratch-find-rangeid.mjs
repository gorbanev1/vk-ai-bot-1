
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/events/publicPostDateEvidence.js', 'utf8').split(/\r?\n/);
for (let i = 1; i <= 380; i++) {
  const line = lines[i - 1] || '';
  if (/rangeId|range-start|range-end|kind.*range/.test(line)) {
    console.log(String(i).padStart(5) + ': ' + line);
  }
}

