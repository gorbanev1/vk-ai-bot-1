
import fs from 'node:fs';
const lines = fs.readFileSync('src/app/botApplication.js', 'utf8').split(/\r?\n/);
for (let i = 6865; i < 6925; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

