import assert from 'node:assert/strict';
import { deduplicateEventsTwoContour } from '../../src/features/events/eventDuplicateResolution.js';

const base = {
    title: 'ORIGAMI — 20 лет альбому «...и ангелы ошибаются»',
    eventDate: '2026-10-22',
    venue: 'DIESEL HALL',
    participants: 'ORIGAMI',
    description: 'Осенний тур к 20-летию альбома.',
    sourceType: 'vk',
};

async function mergeWithAiTime(members) {
    return deduplicateEventsTwoContour(members, {
        arbitrateAmbiguous: async (pairs) => new Map(pairs.map((pair) => [pair.key, {
            verdict: 'same', confidence: 0.99, reason: 'same ORIGAMI event',
        }])),
        consolidateConfirmedGroup: async () => ({ title: base.title, timeLabel: '19:00' }),
    });
}

const sameStart = await mergeWithAiTime([
    { ...base, eventTime: '20:00', timeLabel: 'двери 19:00, начало концерта 20:00' },
    { ...base, sourceType: 'vk_chat', eventTime: '20:00', timeLabel: 'начало концерта 20:00' },
]);
assert.equal(sameStart.events.length, 1);
assert.equal(sameStart.events[0].eventTime, '20:00');
assert.match(sameStart.events[0].timeLabel, /20:00/u);
assert.doesNotMatch(sameStart.events[0].timeLabel, /уточните/u);

const conflictingStarts = await mergeWithAiTime([
    { ...base, eventTime: '20:00' },
    { ...base, sourceType: 'vk_chat', eventTime: '21:00' },
]);
assert.equal(conflictingStarts.events.length, 1);
assert.ok(String(conflictingStarts.events[0].eventTime).includes('20:00 / 21:00'));
assert.match(conflictingStarts.events[0].eventTime, /уточните время начала/iu);
assert.ok(String(conflictingStarts.events[0].timeLabel).includes('20:00 / 21:00'));

console.log('eventDedupeTimeAuthorityV18901.test.mjs: OK');
