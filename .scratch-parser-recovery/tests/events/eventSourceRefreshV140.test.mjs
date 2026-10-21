import assert from 'node:assert/strict';
import test from 'node:test';

import {
    mergeStoredEventWithFreshSource,
    selectFreshEventForStoredEvent,
} from '../../src/features/events/eventSourceRefresh.js';

test('V140 source refresh repairs a missing poster without losing stored fields', () => {
    const existing = {
        id: 7,
        sourceType: 'manual',
        title: 'INDUSTRIAL MADNESS',
        eventDate: '2026-09-05',
        eventTime: '19:00',
        venue: 'The Last of Vavilone',
        participants: 'The Fourth State of Death, Nine Days Later',
        price: '500 ₽',
        description: 'Старый сохранённый анонс.',
        sourceUrl: 'https://vk.ru/wall-24671830_3',
        imagePaths: [],
    };
    const fresh = {
        title: 'INDUSTRIAL MADNESS',
        eventDate: '2026-09-05',
        venue: 'Рок-бар The Last of Vavilone, Воронеж, ул. Кирова, 5',
        imagePaths: ['refreshed_event_announcements/wall-24671830_3-1.jpg'],
    };

    const merged = mergeStoredEventWithFreshSource(existing, fresh, {
        sourceUrl: 'https://vk.ru/wall-24671830_3',
    });

    assert.equal(merged.eventTime, '19:00');
    assert.equal(merged.price, '500 ₽');
    assert.equal(merged.venue, fresh.venue);
    assert.deepEqual(merged.imagePaths, fresh.imagePaths);
});

test('V140 source refresh prefers the same-date event inside a multi-event source', () => {
    const existing = {
        title: 'Industrial Madness',
        eventDate: '2026-09-05',
        venue: 'Last of Vavilone',
    };
    const freshEvents = [
        { title: 'Другая вечеринка', eventDate: '2026-09-06', venue: 'Другой клуб' },
        { title: 'INDUSTRIAL MADNESS', eventDate: '2026-09-05', venue: 'The Last of Vavilone' },
    ];

    assert.equal(
        selectFreshEventForStoredEvent(existing, freshEvents),
        freshEvents[1],
    );
});

test('V140 source refresh does not guess between unrelated digest entries', () => {
    const existing = {
        title: 'Неизвестное сохранённое событие',
        eventDate: '',
        venue: '',
    };
    const freshEvents = [
        { title: 'Концерт Alpha', eventDate: '2026-09-05', venue: 'Клуб A' },
        { title: 'Концерт Beta', eventDate: '2026-09-06', venue: 'Клуб B' },
    ];

    assert.equal(selectFreshEventForStoredEvent(existing, freshEvents), null);
});
