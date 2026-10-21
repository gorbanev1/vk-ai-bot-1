
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
for (let i = 501; i <= 507; i++) {
  console.log((i + 1) + ':', JSON.stringify(lines[i]));
}

