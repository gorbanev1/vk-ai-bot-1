import assert from 'node:assert/strict';

import {
    addDaysToDateString,
    getLocalDateString,
    getLocalDayWindow,
} from '../../src/shared/date.js';

assert.equal(addDaysToDateString('2026-12-31', 1), '2027-01-01');
assert.equal(addDaysToDateString('2026-03-01', -1), '2026-02-28');
assert.equal(
    getLocalDateString(new Date('2026-07-29T21:30:00Z'), 'Europe/Moscow'),
    '2026-07-30',
);

const window = getLocalDayWindow('2026-07-29', 'Europe/Moscow');
assert.equal(window.endTimestamp - window.startTimestamp, 24 * 60 * 60);

console.log('sharedDate tests: OK');
