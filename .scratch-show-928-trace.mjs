
import fs from 'node:fs';
const lines = fs.readFileSync('data/parser-forensic-archives/2026-10-19T20-28-45-773Z_parser-all-secondary-clean_d1012f/trace.jsonl', 'utf8').trim().split(/\r?\n/);
for (const line of lines) {
  if (!line.includes('"sourceId":"vk:koptilnyarest"') || !line.includes('"itemId":"928"')) continue;
  if (!/ai\.text|media\.audit|ai\.media/.test(line)) continue;
  const e = JSON.parse(line);
  console.log('\n=== ' + e.stage + ' seq ' + e.seq + ' ===');
  console.log(JSON.stringify(e.data, null, 2).slice(0, 24000));
}

