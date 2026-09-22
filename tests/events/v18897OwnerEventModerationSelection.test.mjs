import assert from 'node:assert/strict';
import test from 'node:test';

import {
    parseOwnerEventNumberSelection,
    rankOwnerEventModerationCandidates,
} from '../../src/features/events/eventOwnerModerationSelection.js';
import { parseEventModerationCommand } from '../../src/features/events/eventModerationRouting.js';

const events = [
    {
        id: 1,
        sourceType: 'vk',
        title: 'Концерт Кости Цупникова',
        participants: 'Костя Цупников',
        eventDate: '2026-09-18',
        venue: 'Бар Тупик',
    },
    {
        id: 2,
        sourceType: 'telegram',
        title: 'Кости Чумакова — акустика',
        participants: 'Костя Чумаков',
        eventDate: '2026-09-19',
        venue: 'Liverpool',
    },
    {
        id: 3,
        sourceType: 'manual',
        title: 'Совсем другой концерт',
        participants: 'Other Artist',
        eventDate: '2026-09-20',
        venue: 'Diesel Hall',
    },
];

test('V188.97 owner moderation search finds exact, substring and typo-like title fragments', () => {
    let ranked = rankOwnerEventModerationCandidates(events, 'Концерт Кости Цупникова');
    assert.equal(ranked[0].event.id, 1);
    assert.equal(ranked[0].exact, true);

    ranked = rankOwnerEventModerationCandidates(events, 'Цупникова');
    assert.equal(ranked[0].event.id, 1);
    assert.equal(ranked[0].contains, true);

    ranked = rankOwnerEventModerationCandidates(events, 'Чупникова');
    assert.equal(ranked[0].event.id, 1, 'one-letter typo must still surface the correct candidate');

    ranked = rankOwnerEventModerationCandidates(events, 'Кости');
    assert.ok(ranked.some((item) => item.event.id === 1));
    assert.ok(ranked.some((item) => item.event.id === 2));
});

test('V188.97 numbered delete selection accepts single, spaced and compact multi-select forms', () => {
    assert.deepEqual(parseOwnerEventNumberSelection('удалить 1', { max: 5 }), { action: 'select', indexes: [0] });
    assert.deepEqual(parseOwnerEventNumberSelection('удалить 1 2', { max: 5 }), { action: 'select', indexes: [0, 1] });
    assert.deepEqual(parseOwnerEventNumberSelection('удалить 123', { max: 5 }), { action: 'select', indexes: [0, 1, 2] });
    assert.deepEqual(parseOwnerEventNumberSelection('1, 3', { max: 5 }), { action: 'select', indexes: [0, 2] });
    assert.deepEqual(parseOwnerEventNumberSelection('отмена', { max: 5 }), { action: 'cancel', indexes: [] });
});

test('V188.97 edit selection accepts exactly one card', () => {
    assert.deepEqual(parseOwnerEventNumberSelection('исправить 2', { action: 'edit', max: 4 }), { action: 'select', indexes: [1] });
    assert.deepEqual(parseOwnerEventNumberSelection('исправить 12', { action: 'edit', max: 4 }), { action: 'invalid', indexes: [] });
});

test('V188.97 moderation routing supports soft/permanent delete and edit command with or without a query', () => {
    assert.deepEqual(parseEventModerationCommand('тусы удалить Цупникова'), { action: 'delete', query: 'Цупникова' });
    assert.deepEqual(parseEventModerationCommand('тусы удалить насовсем Цупникова'), { action: 'delete-permanent', query: 'Цупникова' });
    assert.deepEqual(parseEventModerationCommand('тусы исправить'), { action: 'edit-start', query: '' });
    assert.deepEqual(parseEventModerationCommand('тусы исправить Цупникова'), { action: 'edit', query: 'Цупникова' });
});
