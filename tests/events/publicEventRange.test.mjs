import assert from 'node:assert/strict';

import {
    compareIsoEventDates,
    createPublicEventRangeService,
    formatIsoEventDate,
    isValidIsoEventDate,
} from '../../src/features/events/publicEventRange.js';

const fixedNow = () => new Date('2026-07-29T12:00:00Z'); // среда, 15:00 MSK
const service = createPublicEventRangeService({
    timeZone: 'Europe/Moscow',
    now: fixedNow,
});

assert.equal(isValidIsoEventDate('2026-02-29'), false);
assert.equal(isValidIsoEventDate('2028-02-29'), true);
assert.equal(compareIsoEventDates('2026-07-29', '2026-08-01') < 0, true);
assert.equal(formatIsoEventDate('2026-07-29'), '29 июля 2026');

assert.deepEqual(
    service.parsePublicEventsRangeCommand('тусы на этих выходных'),
    {
        kind: 'weekend',
        fromDate: '2026-08-01',
        toDate: '2026-08-02',
        label: 'Эти выходные: 1–2 августа 2026',
    },
);
assert.equal(
    service.parsePublicEventsRangeCommand('тусы 22 августа').fromDate,
    '2026-08-22',
);
assert.equal(
    service.publicEventsRangeFromClassifierToken('next14').toDate,
    '2026-08-11',
);
assert.equal(service.looksLikePublicEventsQuestion('куда сходить в выходные'), true);
assert.equal(service.looksLikePublicEventsQuestion('когда следующая туса?'), false);

assert.equal(service.parsePublicEventsRangeCommand('ближайшая туса'), null);
assert.equal(service.parsePublicEventsRangeCommand('когда ближайшая туса'), null);
assert.equal(service.looksLikePublicEventsQuestion('ближайшая туса'), false);
assert.equal(service.parsePublicEventsRangeCommand('ближайшие тусы').kind, 'next14');

console.log('publicEventRange tests: OK');
