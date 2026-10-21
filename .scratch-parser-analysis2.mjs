
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const run = '2026-10-19T20-28-45-773Z_parser-all-secondary-clean_d1012f';
const dir = path.join(root, 'data/parser-forensic-archives', run);
const lines = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const failures = lines.filter((e) => {
  const t = JSON.stringify(e);
  return t.includes('POSTER_GATE_UNRESOLVED') || t.includes('MANUAL_PARSER_RETRY_EXHAUSTED') || t.includes('"ok":false');
});
console.log('failure-related entries: ' + failures.length);
for (const e of failures) {
  const p = e.payload ?? e.data ?? e.details ?? e;
  const src = p.sourceId ?? p.source ?? '';
  if (!src) continue;
  const kind = JSON.stringify(e).includes('POSTER_GATE_UNRESOLVED') ? 'POSTER_GATE' : (JSON.stringify(e).includes('MANUAL_PARSER_RETRY_EXHAUSTED') ? 'RETRY' : 'SOURCE_RESULT');
  console.log('\n[' + kind + '] ' + src);
  console.log(JSON.stringify(p, null, 2).slice(0, 5000));
}

// vision errors
const visionErrors = lines.filter((e) => JSON.stringify(e).includes('posterVisionError'));
console.log('\nvision-error entries: ' + visionErrors.length);
for (const e of visionErrors) {
  console.log(JSON.stringify(e, null, 2).slice(0, 6000));
}

// final summary failed sources
const summary = lines.filter((e) => JSON.stringify(e).includes('"failed":4') || JSON.stringify(e).includes('"sourceFailedCount":4'));
for (const e of summary.slice(-2)) {
  console.log('\nFINAL SUMMARY:\n' + JSON.stringify(e, null, 2).slice(0, 8000));
}

