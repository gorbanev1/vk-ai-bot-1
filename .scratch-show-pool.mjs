
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/scrapers/manualProcessingPool.js', 'utf8').split(/\r?\n/);
for (let i = 230; i < 310; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

