import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

const rangeStart = source.indexOf('function getPublicEventsForRange');
const rangeEnd = source.indexOf('function parseEventModerationCommand', rangeStart);
const rangeCode = source.slice(rangeStart, rangeEnd);
assert.match(rangeCode, /getRawUpcomingEventsForModeration\(2000\)/u);
assert.match(rangeCode, /getEventDateEvidence\(event\)/u);
assert.doesNotMatch(rangeCode, /getCombinedUpcomingEvents\(/u);
assert.doesNotMatch(rangeCode, /deduplicateUpcomingEvents\(/u);
assert.doesNotMatch(rangeCode, /deduplicateEventsStrict\(/u);

const compactStart = source.indexOf('async function sendCompactPublicEventList');
const compactEnd = source.indexOf('function buildSinglePublicEventMessage', compactStart);
const compact = source.slice(compactStart, compactEnd);
assert.match(compact, /aiOnRequest=false/u);
assert.doesNotMatch(compact, /normalizePublicEventsForDisplay\(/u);
assert.doesNotMatch(compact, /deduplicatePublicEventsTwoContour\(/u);

const verifyStart = source.indexOf('async function rebuildVerifiedPartySnapshot');
const verifyEnd = source.indexOf('function rebuildVerifiedPartySnapshotQueued', verifyStart);
const verifyCode = source.slice(verifyStart, verifyEnd);
assert.match(verifyCode, /scanEventsWithDeepEventDedupe/u);
assert.match(verifyCode, /replaceEventDedupeRegistry/u);
assert.match(verifyCode, /summarizePublicEventsCompactWithMini\(canonicalEvents\)/u);

const scanStart = source.indexOf('async function scanEventsWithDeepEventDedupe');
const scanEnd = source.indexOf('async function scanCurrentDatabaseWithDeepEventDedupe', scanStart);
const scanCode = source.slice(scanStart, scanEnd);
assert.match(scanCode, /normalizePublicEventsForDisplay\(taggedRawEvents\)/u);
assert.match(scanCode, /deduplicatePublicEventsTwoContour\(normalizedEvents\)/u);

assert.match(source, /getEventDateEvidence,/u);
assert.match(source, /events-v\d+-[a-z0-9-]+/u);

console.log('eventDedupeIntegrationV95.test.mjs: OK');
