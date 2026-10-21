
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'src/app/botApplication.js');
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
for (let i = 30086 - 1; i < 30120; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}
console.log('...');
for (let i = 30120 - 1; i < 30220; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

