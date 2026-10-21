
import fs from 'node:fs';

const file = 'src/app/botApplication.js';
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
for (let i = 7190; i < 7285; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

