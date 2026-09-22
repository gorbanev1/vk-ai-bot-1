import assert from 'node:assert/strict';
import {
    compareEventsDeterministic,
    deduplicateEventsTwoContour,
    mergeDuplicateEvents,
} from '../../src/features/events/eventDuplicateResolution.js';

const dayOne = {
    title: 'Same Festival',
    eventDate: '2026-08-21',
    displayDate: '21.08.26–23.08.26',
    venue: 'Venue X',
    participants: 'Artist A',
    description: 'First day programme.',
    sourceType: 'vk',
    sourceUrl: 'https://vk.ru/wall-1_1',
};
const dayTwo = {
    ...dayOne,
    eventDate: '2026-08-22',
    sourceUrl: 'https://vk.ru/wall-1_2',
    description: 'Second day programme.',
};

const deterministic = compareEventsDeterministic(dayOne, dayTwo);
assert.equal(deterministic.verdict, 'different');
assert.ok(deterministic.hardConflicts.includes('different-date'));

const result = await deduplicateEventsTwoContour([dayOne, dayTwo], {
    // Different calendar dates must never reach the AI merge path.
    arbitrateAmbiguous: async () => {
        throw new Error('AI must not arbitrate different calendar dates');
    },
});
assert.equal(result.events.length, 2);

// Defensive guard for recovery/final-sweep callers.
const guarded = mergeDuplicateEvents(dayOne, dayTwo, { contour: 'test' });
assert.equal(guarded.eventDate, dayOne.eventDate);
assert.equal(guarded._duplicateResolution.contour, 'test');
assert.ok(guarded._duplicateResolution.reasons.includes('blocked-different-calendar-date'));

console.log('dedupeDistinctCalendarDate.test.mjs: OK');
