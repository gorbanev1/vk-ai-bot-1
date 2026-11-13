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
        fromDate: '2026-07-31',
        toDate: '2026-08-02',
        label: 'Эти выходные: 31 июля — 2 августа 2026',
    },
);
assert.equal(
    service.parsePublicEventsRangeCommand('тусы 22 августа').fromDate,
    '2026-08-22',
);
assert.equal(service.parsePublicEventsRangeCommand('тусы 29').fromDate, '2026-07-29');
assert.equal(service.parsePublicEventsRangeCommand('тусы 19').fromDate, '2026-08-19');
for (const query of [
    'тусы 13 по 15 января',
    'тусы с 13 по 15 января',
    'тусы 13.01-15.01',
    'тусы 13-15.01',
    'тусы с 13 января по 15 января',
]) {
    const range = service.parsePublicEventsRangeCommand(query);
    assert.equal(range?.kind, 'date-range', query);
    assert.equal(range?.fromDate, '2027-01-13', query);
    assert.equal(range?.toDate, '2027-01-15', query);
}
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
assert.equal(service.parsePublicEventsRangeCommand('тусы вообще за всё время').kind, 'all');
assert.equal(service.parsePublicEventsRangeCommand('тусы за все время').kind, 'all');
assert.equal(service.parsePublicEventsRangeCommand('тусы все будущие события').kind, 'all');
assert.equal(service.parsePublicEventsRangeCommand('все тусы').kind, 'all');
assert.equal(service.parsePublicEventsRangeCommand('вообще все тусы').kind, 'all');
assert.deepEqual(
    service.parsePublicEventsRangeCommand('тусы сентябрь октябрь ноябрь'),
    {
        kind: 'month',
        fromDate: '2026-09-01',
        toDate: '2026-11-30',
        label: 'Тусы за сентябрь октябрь ноябрь: 1 сентября — 30 ноября 2026',
    },
);
assert.deepEqual(
    service.parsePublicEventsRangeCommand('тусы на этой неделе'),
    {
        kind: 'week',
        fromDate: '2026-07-29',
        toDate: '2026-08-02',
        label: 'Эта неделя: 29 июля — 2 августа 2026',
    },
);
assert.deepEqual(
    service.parsePublicEventsRangeCommand('тусы на две недели'),
    {
        kind: 'next14',
        fromDate: '2026-07-29',
        toDate: '2026-08-11',
        label: 'Ближайшие 14 дней: 29 июля — 11 августа 2026',
    },
);
assert.deepEqual(
    service.parsePublicEventsRangeCommand('тусы на месяц'),
    {
        kind: 'next30',
        fromDate: '2026-07-29',
        toDate: '2026-08-28',
        label: 'Ближайший месяц: 29 июля — 28 августа 2026',
    },
);
assert.deepEqual(
    service.parsePublicEventsRangeCommand('тусы в октябре'),
    {
        kind: 'month',
        fromDate: '2026-10-01',
        toDate: '2026-10-31',
        label: 'Тусы за октябрь: 1–31 октября 2026',
    },
);

console.log('publicEventRange tests: OK');
