
import fs from 'node:fs';
const lines = fs.readFileSync('tests/scrapers/parserPhasePlan.test.mjs', 'utf8').split(/\r?\n/);
for (let i = 1; i <= lines.length; i++) {
  console.log(String(i).padStart(5) + ': ' + lines[i - 1]);
}

