import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const start = app.indexOf('function buildCompactPublicEventsMessage(items, range) {');
const end = app.indexOf('function buildSinglePublicEventMessage(event) {', start);
assert.ok(start >= 0 && end > start, 'compact formatter must exist');
const compact = app.slice(start, end);

assert.ok(compact.includes('const summary = normalizeCompactSummary(item?.compactSummary'));
assert.match(compact, /await sendLong\(context, message\)/u);
assert.match(compact, /'images=false'/u);
assert.match(compact, /'layout=single-list'/u);
assert.match(compact, /'description=true'/u);
assert.doesNotMatch(compact, /getEventAttachments\(/u);
assert.doesNotMatch(compact, /buildCompactMergedSourceLines\(/u);
assert.match(compact, /compactSummary/u);
assert.ok(compact.includes('`📝 ${summary}`'));

console.log('compactPartyActuallyBriefV18837 tests: OK');
