// Read-only replay of saved AI replies: no model calls or database writes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validatePublicAiEvents } from '../src/features/events/publicPostLocalParser.js';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/replay-parser-text-validation.mjs <forensic-directory>');
const rows = readFileSync(resolve(directory, 'trace.jsonl'), 'utf8').trim().split(/\r?\n/u).map(JSON.parse);
for (const row of rows.filter((row) => row.stage === 'item.ai.text-extraction.response')) {
    const { sourceId, itemId, parsedEvents } = row.data;
    const same = (r) => r.data?.sourceId === sourceId && r.data?.itemId === itemId && r.seq < row.seq;
    const body = rows.find((r) => same(r) && r.stage === 'item.prefilter')?.data.semanticBodyText || '';
    const facts = rows.filter((r) => same(r) && r.stage === 'item.ai.vision.response').at(-1)?.data.responseText || '';
    const result = validatePublicAiEvents(parsedEvents, { text: [body, '[Факты с афиши]', facts].join('\n\n'), publishedAt: Math.floor(Date.parse(row.ts) / 1000) });
    console.log(JSON.stringify({ sourceId, itemId, expected: parsedEvents.length, accepted: result.length, valid: result.aiResponseValid, error: result.aiResponseError, titles: result.map((e) => e.title) }));
    if (result.length !== parsedEvents.length || !result.aiResponseValid) process.exitCode = 1;
}
