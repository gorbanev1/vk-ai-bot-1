
import fs from 'node:fs';
const text = fs.readFileSync('src/features/events/publicPostDateEvidence.js', 'utf8');
const lines = text.split(/\r?\n/);
const idx = text.indexOf('function pushMention');
console.log('pushMention at line', text.slice(0, idx).split('\n').length);
for (let i = text.slice(0, idx).split('\n').length - 1; i < text.slice(0, idx).split('\n').length + 40; i++) {
  console.log(String(i + 1).padStart(5) + ': ' + lines[i]);
}

