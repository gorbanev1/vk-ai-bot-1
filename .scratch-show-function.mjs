
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'src/app/botApplication.js');
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);

const needle = 'function extractPosterGateFactsWithVision';
const idx = text.indexOf(needle);
console.log('index of function: ' + idx);
if (idx < 0) {
  process.exit(0);
}
const lineStart = text.lastIndexOf('\n', idx) + 1;
const startLine = text.slice(0, lineStart).split('\n').length;
console.log('function starts at line ' + startLine);
for (let i = Math.max(0, startLine - 15); i < Math.min(lines.length, startLine + 130); i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

