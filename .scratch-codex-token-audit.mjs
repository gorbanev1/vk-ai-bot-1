import { createReadStream } from 'node:fs';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(process.env.USERPROFILE, '.codex', 'sessions', '2026');
const start = Date.parse('2026-10-06T00:00:00+03:00');
const end = Date.parse('2026-10-21T00:00:00+03:00');

async function readText(file) {
  if (!file.endsWith('.zst')) return readFile(file, 'utf8');
  const out = join(tmpdir(), 'codex-audit-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.jsonl');
  await pipeline(createReadStream(file), createZstdDecompress(), createWriteStream(out));
  const text = await readFile(out, 'utf8');
  try { await unlink(out); } catch {}
  return text;
}

async function walk(dir) {
  const rows = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) rows.push(...await walk(p));
    else if (/\.jsonl(?:\.zst)?$/.test(ent.name)) rows.push(p);
  }
  return rows;
}

const files = await walk(root);
const byDay = new Map();
const byModel = new Map();
const byProvider = new Map();
const sessions = [];
const periodByModel = new Map();
const periodByDay = new Map();
function addDelta(map, key, row) {
  const x = map.get(key) || { events:0, input:0, cached:0, output:0, reasoning:0, total:0 };
  x.events += 1;
  x.input += row.input; x.cached += row.cached; x.output += row.output; x.reasoning += row.reasoning; x.total += row.total;
  map.set(key, x);
}
for (const file of files) {
  let text;
  try { text = await readText(file); } catch { continue; }
  const lines = text.split(/\r?\n/);
  let meta = null;
  let modelName = 'unknown';
  let previousTotal = null;
  let previousUsage = null;
  let last = null;
  for (const line of lines) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'session_meta') meta = j.payload || {};
    const candidateModel = j.payload?.model || j.payload?.state?.model || j.payload?.model_name || j.payload?.state?.model_name;
    if (candidateModel) modelName = String(candidateModel);
    if (j.type === 'event_msg' && j.payload?.type === 'token_count') {
      const usage = j.payload.info?.total_token_usage;
      if (usage && Number.isFinite(Number(usage.total_tokens))) {
        last = usage;
        const currentTotal = Number(usage.total_tokens || 0);
        const prevTotal = Number(previousTotal ?? 0);
        const deltaTotal = Math.max(0, currentTotal - prevTotal);
        const delta = {
          input: Math.max(0, Number(usage.input_tokens || 0) - Number(previousUsage?.input_tokens || 0)),
          cached: Math.max(0, Number(usage.cached_input_tokens || 0) - Number(previousUsage?.cached_input_tokens || 0)),
          output: Math.max(0, Number(usage.output_tokens || 0) - Number(previousUsage?.output_tokens || 0)),
          reasoning: Math.max(0, Number(usage.reasoning_output_tokens || 0) - Number(previousUsage?.reasoning_output_tokens || 0)),
          total: deltaTotal,
        };
        const eventTs = Date.parse(j.timestamp || '');
        if (deltaTotal > 0 && Number.isFinite(eventTs) && eventTs >= start && eventTs < end) {
          const date = new Date(eventTs).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
          const model = String(modelName || 'unknown');
          addDelta(periodByDay, date, delta);
          addDelta(periodByModel, model, delta);
        }
        previousTotal = currentTotal;
        previousUsage = usage;
      }
    }
  }
  if (!last) continue;
  const stamp = meta?.timestamp || meta?.created_at || '';
  const ts = Date.parse(stamp);
  if (!Number.isFinite(ts) || ts < start || ts >= end) continue;
  const model = String(meta?.model || modelName || 'unknown');
  const provider = String(meta?.model_provider || 'unknown');
  const date = new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const row = { input:Number(last.input_tokens||0), cached:Number(last.cached_input_tokens||0), output:Number(last.output_tokens||0), reasoning:Number(last.reasoning_output_tokens||0), total:Number(last.total_tokens||0) };
  sessions.push({ file, date, model, provider, ...row });
  for (const [map, key] of [[byDay, date], [byModel, model], [byProvider, provider]]) {
    const x = map.get(key) || { sessions:0, input:0, cached:0, output:0, reasoning:0, total:0 };
    x.sessions += 1; x.input += row.input; x.cached += row.cached; x.output += row.output; x.reasoning += row.reasoning; x.total += row.total;
    map.set(key, x);
  }
}
const sort = map => Object.fromEntries([...map.entries()].sort((a,b)=>b[1].total-a[1].total));
console.log(JSON.stringify({window:{start:'2026-10-06T00:00:00+03:00',end:'2026-10-21T00:00:00+03:00'},files:files.length,sessions:sessions.length,bySessionDay:sort(byDay),bySessionModel:sort(byModel),periodByDay:sort(periodByDay),periodByModel:sort(periodByModel)}, null, 2));
