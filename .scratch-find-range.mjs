
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostLocalParser.js', 'utf8');
const lines = text.split(/\r?\n/);
const idx = text.indexOf('function extractExplicitDates');
console.log('extractExplicitDates at approx line', lines.slice(0, text.slice(0, idx).split('\n').length).length);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('18–30') || lines[i].includes('date range') || lines[i].includes('dateRange') || lines[i].includes('expand')) {
    console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
  }
}

