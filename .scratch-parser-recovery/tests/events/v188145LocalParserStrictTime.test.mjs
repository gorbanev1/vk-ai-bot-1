import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const publishedAt = Math.floor(new Date('2026-08-20T12:00:00Z').getTime() / 1000);

test('local public parser keeps dot-delimited values as dates, never event times', () => {
    const [dotClock] = parsePublicPostLocally({
        text: '27 августа, 20.00 - Кошка Сашка',
        publishedAt,
        screenName: 'liverpool_pub_vrn',
    });
    assert.equal(dotClock.eventDate, '2026-08-27');
    assert.equal(dotClock.eventTime, null);

    const [colonClock] = parsePublicPostLocally({
        text: '27 августа, 20:00 - Кошка Сашка',
        publishedAt,
        screenName: 'liverpool_pub_vrn',
    });
    assert.equal(colonClock.eventDate, '2026-08-27');
    assert.equal(colonClock.eventTime, '20:00');

    const [explicitHyphenClock] = parsePublicPostLocally({
        text: '27 августа, начало 20-00 - Кошка Сашка',
        publishedAt,
        screenName: 'liverpool_pub_vrn',
    });
    assert.equal(explicitHyphenClock.eventDate, '2026-08-27');
    assert.equal(explicitHyphenClock.eventTime, '20:00');
});
