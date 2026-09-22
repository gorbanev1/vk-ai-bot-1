import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('V131 splits a pinned Liverpool schedule into distinct dated events', () => {
    const text = `Liverpool Pub запись закреплена Расписание концертов на август и сентябрь:
27 августа, 20:00 - Кошка Сашка,
билеты ticketscloud.com/v1/widgets...
28 августа, 21:00 - Stout Band, вход свободный
11 сентября, 21:00 - Red Fox Tails, вход свободный
19 сентября, 20:00 - Алексей Вдовин,
билеты vdovinvrn.ticketscloud.org/
20 сентября, 19:00 - Игорь Лисов,
билеты voronezh.qtickets.events/246771
26 сентября, 20:00 - Алексей Панасовский,
билеты moscow.qtickets.events/252371`;

    const events = parsePublicPostLocally({
        text,
        publishedAt: unix('2026-08-20T12:00:00Z'),
        screenName: 'liverpool_pub_vrn',
    });

    assert.deepEqual(events.map((event) => [event.title, event.eventDate, event.eventTime]), [
        ['Кошка Сашка', '2026-08-27', '20:00'],
        ['Stout Band', '2026-08-28', '21:00'],
        ['Red Fox Tails', '2026-09-11', '21:00'],
        ['Алексей Вдовин', '2026-09-19', '20:00'],
        ['Игорь Лисов', '2026-09-20', '19:00'],
        ['Алексей Панасовский', '2026-09-26', '20:00'],
    ]);
    assert.equal(events[1].price.toLowerCase(), 'вход свободный');
    assert.ok(events.every((event) => event.parseMethod === 'local_inline_schedule_v131'));
});

test('V18821 never invents a title when the source only contains date/time', () => {
    const [event] = parsePublicPostLocally({
        text: '27 августа, 20:00\nБилеты тут - ticketscloud.com/v1/widgets... 13',
        publishedAt: unix('2026-08-20T12:00:00Z'),
        screenName: 'liverpool_pub_vrn',
    });

    assert.equal(event.eventDate, '2026-08-27');
    assert.equal(event.eventTime, '20:00');
    assert.notEqual(event.title, '27 августа, 20.00');
    assert.equal(event.title, '');
});
