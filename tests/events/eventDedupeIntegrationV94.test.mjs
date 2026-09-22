import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

const compactStart = source.indexOf('async function sendCompactPublicEventList');
const compactEnd = source.indexOf('function buildSinglePublicEventMessage', compactStart);
const compact = source.slice(compactStart, compactEnd);
assert.match(compact, /aiOnRequest=false/u);
assert.doesNotMatch(compact, /deduplicatePublicEventsTwoContour\(/u);
assert.doesNotMatch(compact, /deduplicateEventsStrict\(/u);

const normalStart = source.indexOf('async function sendPublicEventMessages');
const normalEnd = source.indexOf('function formatNoPublicEvents', normalStart);
const normal = source.slice(normalStart, normalEnd);
assert.match(normal, /deduplicatePublicEventsTwoContour\(normalizedEvents\)/u);
assert.doesNotMatch(normal, /deduplicateEventsStrict\(normalizedEvents/u);

assert.match(source, /consolidateConfirmedGroup:\s*consolidateConfirmedEventGroupWithMini/u);
assert.match(source, /deriveEventScheduleDays\(event\)/u);
assert.match(source, /formatMergedEventSources\(event\)/u);
assert.match(source, /🔗 Источники:/u);

console.log('eventDedupeIntegrationV94.test.mjs: OK');
