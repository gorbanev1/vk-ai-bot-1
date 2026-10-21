import assert from 'node:assert/strict';

import {
    enrichEventMetadata,
    extractEventDate,
    extractEventPrice,
    extractEventTime,
    extractEventVenue,
} from '../../src/features/events/eventMetadata.js';

const text = `
28 августа — MAUSOLEUM — Воронеж
Панк-хардкор концерт.
При поддержке:
diZbadiX
Колхозная Самодеятельность
Двери: 19:00
Вход: 700 рублей
Rock Bar DIESEL Hall
18+
Билеты: vk.cc/cZ34cW
`;

assert.equal(
    extractEventDate(text, { referenceDate: new Date('2026-07-29T00:00:00Z') }),
    '2026-08-28',
);
assert.equal(extractEventTime(text), '19:00');
assert.match(extractEventVenue(text), /diesel hall/iu);
assert.match(extractEventPrice(text), /700/iu);

const enriched = enrichEventMetadata({
    title: 'MAUSOLEUM — Воронеж',
    description: text,
    eventDate: '2026-08-28',
});

assert.equal(enriched.eventTime, '19:00');
assert.match(enriched.venue, /diesel hall/iu);
assert.match(enriched.price, /700/iu);
assert.equal(enriched.ageRestriction, '18+');
assert.equal(enriched.eventType, 'Концерт');
assert.ok(enriched.contentLinks.includes('vk.cc/cz34cw'));

console.log('eventMetadata tests: OK');
