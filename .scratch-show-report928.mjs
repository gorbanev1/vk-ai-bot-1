
import fs from 'node:fs';
const file = 'data/parser-forensic-archives/2026-10-19T20-28-45-773Z_parser-all-secondary-clean_d1012f/vk-koptilnyarest.parser-report.json';
const text = fs.readFileSync(file, 'utf8');
const needle = '928';
let idx = 0;
let found = 0;
while ((idx = text.indexOf(needle, idx)) !== -1 && found < 3) {
  console.log('--- occurrence ' + (++found) + ' at ' + idx + ' ---');
  console.log(text.slice(Math.max(0, idx - 1500), idx + 3000));
  idx += needle.length;
}

