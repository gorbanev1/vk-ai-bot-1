
import fs from 'node:fs';

const file = 'src/app/botApplication.js';
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
for (let i = 7285; i < 7340; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

