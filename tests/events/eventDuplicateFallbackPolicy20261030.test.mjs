import assert from 'node:assert/strict';
import { deduplicateEventsTwoContour, metadataFallbackResolution, orderedTokenSimilarity } from '../../src/features/events/eventDuplicateResolution.js';

const base = { eventDate: '2026-10-30', timeLabel: '19:30', venue: 'Berserk Bar', participants: 'DEEP STATE; ЛОТОВЬ; ???' };
const left = { ...base, title: 'ДЕНЬ ОРТОПЕДИЧЕСКОЙ МЕДСЕСТРЫ', sourceType: 'telegram', sourceUrl: 'tg://1' };
const right = { ...base, title: 'ДЕНЬ ОРТОПЕДИЧЕСКОЙ МЕДСЕСТРЫ концерт', sourceType: 'vk', sourceUrl: 'vk://2' };

assert.ok(orderedTokenSimilarity('one two three', 'one two three') > 0.99);
assert.ok(orderedTokenSimilarity('one two three', 'three two one') < orderedTokenSimilarity('one two three', 'one two four'));
assert.equal(metadataFallbackResolution(left, { ...right, eventDate: '2026-10-31' }).verdict, 'different');

const aiDifferent = await deduplicateEventsTwoContour([left, right], {
    arbitrateAmbiguous: async (pairs) => new Map(pairs.map((pair) => [pair.key, { verdict: 'different', confidence: 0.99, reason: 'ai-says-different' }])),
});
assert.equal(aiDifferent.events.length, 2);

const aiUnavailable = await deduplicateEventsTwoContour([left, right], {
    arbitrateAmbiguous: async () => new Map(),
});
assert.equal(aiUnavailable.events.length, 1);
assert.match(String(aiUnavailable.merges[0]?.contour || ''), /metadata-fallback|ai/u);

const aiUncertain = await deduplicateEventsTwoContour([left, right], {
    arbitrateAmbiguous: async (pairs) => new Map(pairs.map((pair) => [pair.key, { verdict: 'uncertain', confidence: 0.4, reason: 'insufficient evidence' }])),
});
assert.equal(aiUncertain.events.length, 2, 'explicit AI uncertain must not invoke metadata fallback');

console.log('eventDuplicateFallbackPolicy20261030.test.mjs: OK');
