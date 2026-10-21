
import fs from 'node:fs';
const lines = fs.readFileSync('src/features/scrapers/manualProcessingPool.js', 'utf8').split(/\r?\n/);
for (let i = 1; i <= 100; i++) {
  console.log(String(i).padStart(5) + ': ' + lines[i - 1]);
}

