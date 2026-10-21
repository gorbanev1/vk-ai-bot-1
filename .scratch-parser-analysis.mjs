
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const archive = (name) => path.join(root, 'data/parser-forensic-archives', name);
const runs = [
  '2026-10-19T18-15-27-553Z_parser-all-secondary_ecf500',
  '2026-10-19T20-28-45-773Z_parser-all-secondary-clean_d1012f',
];
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

for (const run of runs) {
  console.log('=== ' + run + ' ===');
  const files = fs.readdirSync(archive(run)).filter((f) => f.endsWith('.parser-report.json') && (f.startsWith('vk-') || f.startsWith('tg-')));
  for (const f of files) {
    const report = readJson(path.join(archive(run), f));
    const text = JSON.stringify(report);
    const hasIssue = /unresolved|retry_exhausted|POSTER_GATE_UNRESOLVED|retry-cycle/i.test(text);
    if (hasIssue) {
      console.log('FILE: ' + f);
      console.log(text.slice(0, 12000));
    }
  }

  const traceFile = path.join(archive(run), 'trace.jsonl');
  if (!fs.existsSync(traceFile)) {
    console.log('(no trace)');
    continue;
  }
  const lines = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const interesting = lines.filter((entry) => /retry_exhausted|unresolved|POSTER_GATE_UNRESOLVED|retry-cycle|fulfilled|rejected/i.test(JSON.stringify(entry)));
  console.log('TRACE interesting events: ' + interesting.length);
  for (const entry of interesting) {
    const item = entry.itemId ?? entry.item_id ?? entry.item ?? entry.id ?? '';
    const ts = entry.timestamp ?? entry.ts ?? entry.time ?? '';
    console.log(ts + ' | ' + item + ' | ' + (entry.event ?? entry.type ?? '') + ' | ' + (entry.phase ?? '') + ' | ' + (entry.status ?? ''));
    const payload = JSON.stringify(entry.payload ?? entry.data ?? entry.details ?? {});
    if (payload && payload !== '{}') console.log('  ' + payload.slice(0, 1000));
  }
}

