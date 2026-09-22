import assert from 'node:assert/strict';

import {
    formatNatalBirthData,
    parseNatalBirthData,
} from '../../src/features/astrology/natalRouting.js';

const parsed = parseNatalBirthData(
    'pro3 натал 14.03.1987 19:40 Воронеж подробно',
    { timeZone: 'Europe/Moscow' },
);

assert.equal(parsed.ok, true);
assert.equal(parsed.instant.toISOString(), '1987-03-14T16:40:00.000Z');
assert.match(formatNatalBirthData(parsed), /14\.03\.1987/u);
assert.match(formatNatalBirthData(parsed), /19:40/u);

const yekaterinburg = parseNatalBirthData(
    'натал 01.01.2026 12:00 Екатеринбург',
    { timeZone: 'Asia/Yekaterinburg' },
);
assert.equal(yekaterinburg.ok, true);
assert.equal(yekaterinburg.instant.toISOString(), '2026-01-01T07:00:00.000Z');

const newYorkSummer = parseNatalBirthData(
    'natal 01.07.2026 12:00 New York',
    { timeZone: 'America/New_York' },
);
assert.equal(newYorkSummer.ok, true);
assert.equal(newYorkSummer.instant.toISOString(), '2026-07-01T16:00:00.000Z');

const missingTime = parseNatalBirthData('натал 14.03.1987 Воронеж');
assert.equal(missingTime.ok, false);
assert.deepEqual(missingTime.missing, ['точное время рождения']);

const invalid = parseNatalBirthData('натал 31.02.1987 19:40 Воронеж');
assert.equal(invalid.ok, false);
assert.match(invalid.error, /Некорректная дата/iu);

console.log('natalRouting tests: OK');
