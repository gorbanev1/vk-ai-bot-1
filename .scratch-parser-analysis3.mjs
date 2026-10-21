
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const run = '2026-10-19T20-28-45-773Z_parser-all-secondary-clean_d1012f';
const lines = fs.readFileSync(path.join(root, 'data/parser-forensic-archives', run, 'trace.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const wanted = new Set([
  JSON.stringify(['vk:rest1900', '36']),
  JSON.stringify(['vk:naryadny.rest', '215']),
  JSON.stringify(['vk:xlambar', '16149']),
  JSON.stringify(['vk:koptilnyarest', '928']),
]);

for (const e of lines) {
  const p = e.data ?? e.payload ?? e;
  const src = p.sourceId ?? '';
  const item = p.itemId != null ? String(p.itemId) : '';
  if (!wanted.has(JSON.stringify([src, item]))) continue;
  const stage = e.stage ?? p.stage ?? '';
  if (!/vision|poster|admission|queue|item.|ai|result|complete/i.test(stage)) continue;
  const text = JSON.stringify(p);
  if (!/vision|poster|unresolved|retry|error|ai|result/i.test(text)) continue;
  console.log('\n=== ' + src + ' item ' + item + ' | ' + stage + ' | seq ' + (e.seq ?? '') + ' ===');
  console.log(text.slice(0, 12000));
}

