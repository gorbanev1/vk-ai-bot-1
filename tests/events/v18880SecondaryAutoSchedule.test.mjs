import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECONDARY_PARTY_AUTO_HOUR,
  SECONDARY_PARTY_AUTO_INTERVAL_DAYS,
  getInitialSecondaryPartyAutoRunAt,
  getNextSecondaryPartyAutoRunAt,
} from '../../src/features/events/secondaryPartyAutoSchedule.js';

const zone = 'Europe/Moscow';

test('secondary auto parser is anchored to 04:00 local and then repeats every three days', () => {
  assert.equal(SECONDARY_PARTY_AUTO_HOUR, 4);
  assert.equal(SECONDARY_PARTY_AUTO_INTERVAL_DAYS, 3);
  const initial = getInitialSecondaryPartyAutoRunAt({ now: Date.parse('2026-09-15T12:00:00Z'), timeZone: zone });
  assert.equal(new Date(initial * 1000).toISOString(), '2026-09-16T01:00:00.000Z');
  const next = getNextSecondaryPartyAutoRunAt({ scheduledAt: initial, now: initial * 1000 + 1000, timeZone: zone });
  assert.equal(new Date(next * 1000).toISOString(), '2026-09-19T01:00:00.000Z');
});

test('missed cadence advances to first future 04:00 slot without shifting the three-day anchor', () => {
  const scheduled = Date.parse('2026-09-16T01:00:00Z') / 1000;
  const next = getNextSecondaryPartyAutoRunAt({
    scheduledAt: scheduled,
    now: Date.parse('2026-09-23T12:00:00Z'),
    timeZone: zone,
  });
  assert.equal(new Date(next * 1000).toISOString(), '2026-09-25T01:00:00.000Z');
});
