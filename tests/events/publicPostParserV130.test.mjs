import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('V130 keeps explicit historical year instead of promoting stale Overlock post to 2026', () => {
    const [event] = parsePublicPostLocally({
        text: 'GET BASS / 22.11 / OVERLOCK 22 ноября 2024 года. Начало в 23:00. Воронеж, Пушкинская 5',
        publishedAt: unix('2024-11-10T12:00:00Z'),
        screenName: 'overlockbar',
    });
    assert.equal(event.eventDate, '2024-11-22');
    assert.equal(event.eventTime, '23:00');
});

test('V130 infers yearless dates only from reliable publication date', () => {
    const [event] = parsePublicPostLocally({
        text: '6 декабря ONLY VINYL CLUB! Начало 20:30. Вход свободный.',
        publishedAt: unix('2024-11-20T12:00:00Z'),
        screenName: 'overlockbar',
    });
    assert.equal(event.eventDate, '2024-12-06');

    const withoutPublicationEvidence = parsePublicPostLocally({
        text: '6 декабря ONLY VINYL CLUB! Начало 20:30. Вход свободный.',
        publishedAt: 0,
        screenName: 'overlockbar',
    });
    assert.equal(withoutPublicationEvidence.length, 0);
});
