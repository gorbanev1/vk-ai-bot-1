import assert from 'node:assert/strict';
import test from 'node:test';
import {
    EVENT_DEDUPE_ALGORITHM_VERSION,
    compareEventsDeterministic,
    mergeDuplicateEvents,
} from '../../src/features/events/eventDuplicateResolution.js';

test('parent schedule child and linked direct wall merge by canonical provenance', () => {
    const parentChild = {
        title: 'SENAMIRHA',
        eventDate: '2026-10-11',
        eventTime: '19:00',
        venue: 'The Last of Vavilone',
        sourceType: 'vk',
        sourceUrl: 'https://vk.ru/wall-1_100',
        canonicalPostUrl: 'https://vk.ru/wall-240444315_7',
        sourceOriginalUrl: 'https://vk.ru/wall-1_100',
        canonicalOrigin: 'schedule-child-link',
    };
    const direct = {
        title: 'SENAMIRHA — THE LAST OF VAVILONE',
        eventDate: '2026-10-11',
        eventTime: '19:00',
        venue: 'The Last of Vavilone',
        sourceType: 'vk',
        sourceUrl: 'https://vk.ru/wall-240444315_7',
        canonicalPostUrl: 'https://vk.ru/wall-240444315_7',
        canonicalOrigin: 'direct-wall',
    };
    const comparison = compareEventsDeterministic(parentChild, direct);
    assert.equal(comparison.verdict, 'same');
    assert.ok(comparison.reasons.includes('same-canonical-post'));
    const merged = mergeDuplicateEvents(parentChild, direct, comparison);
    assert.equal(merged.sourceUrl, 'https://vk.ru/wall-240444315_7');
    assert.equal(merged.canonicalPostUrl, 'https://vk.ru/wall-240444315_7');
    assert.equal(merged.sourceOriginalUrl, 'https://vk.ru/wall-1_100');
    assert.equal(merged.canonicalOrigin, 'direct-wall');
});

test('V188.75 canonical provenance cannot merge DIESEL Hall with DIESEL Bar', () => {
    const left = {
        title: 'Same Artist', eventDate: '2026-10-11', eventTime: '19:00', venue: 'Diesel Hall',
        canonicalPostUrl: 'https://vk.ru/wall-1_2', sourceUrl: 'https://vk.ru/wall-9_9',
    };
    const right = {
        title: 'Same Artist', eventDate: '2026-10-11', eventTime: '19:00', venue: 'Diesel Bar',
        canonicalPostUrl: 'https://vk.ru/wall-1_2', sourceUrl: 'https://vk.ru/wall-1_2',
    };
    const comparison = compareEventsDeterministic(left, right);
    assert.equal(comparison.verdict, 'different');
    assert.ok(comparison.hardConflicts.includes('different-venue'));
});

test('dedupe algorithm version invalidates old verified snapshot identity', () => {
    assert.match(EVENT_DEDUPE_ALGORITHM_VERSION, /v18875/u);
});
