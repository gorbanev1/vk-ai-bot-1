import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    getNextAutoSummaryRunAt,
    resolveAutoSummaryRunWindow,
    formatAutoSummaryMode,
} from '../../src/features/ai/autoSummaryRouting.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const ts = (iso) => Math.floor(Date.parse(iso) / 1000);
const tz = 'Europe/Moscow';

test('V183 reporting day starts at 06:00 Moscow', () => {
    const window = resolveAutoSummaryRunWindow({
        mode: 'full',
        scheduledTimestamp: ts('2026-09-07T18:00:00+03:00'),
        timeZone: tz,
    });
    assert.equal(window.summaryDate, '2026-09-07');
    assert.equal(window.startTimestamp, ts('2026-09-07T06:00:00+03:00'));
    assert.equal(window.endTimestamp, ts('2026-09-07T18:00:00+03:00'));
});

test('V183 day-only mode runs at 06:00 and covers previous 06:00→06:00', () => {
    const next = getNextAutoSummaryRunAt({
        mode: 'day',
        afterTimestamp: ts('2026-09-07T18:01:00+03:00'),
        timeZone: tz,
    });
    assert.equal(next, ts('2026-09-08T06:00:00+03:00'));
    const window = resolveAutoSummaryRunWindow({
        mode: 'day',
        scheduledTimestamp: next,
        timeZone: tz,
    });
    assert.equal(window.summaryDate, '2026-09-07');
    assert.equal(window.slotLabel, '06:00');
    assert.equal(window.startTimestamp, ts('2026-09-07T06:00:00+03:00'));
    assert.equal(window.endTimestamp, ts('2026-09-08T06:00:00+03:00'));
    assert.match(formatAutoSummaryMode('day'), /06:00/u);
});

test('V183 pre-06 custom slot belongs to previous bot-day', () => {
    const window = resolveAutoSummaryRunWindow({
        mode: 'custom',
        schedule: ['02:00'],
        scheduledTimestamp: ts('2026-09-08T02:00:00+03:00'),
        timeZone: tz,
    });
    assert.equal(window.summaryDate, '2026-09-07');
    assert.equal(window.startTimestamp, ts('2026-09-07T06:00:00+03:00'));
    assert.equal(window.endTimestamp, ts('2026-09-08T02:00:00+03:00'));
});

test('V183 has no emergency/local autoresume delivery and retries failed AI forever', () => {
    assert.doesNotMatch(appSource, /Аварийная локальная выжимка/u);
    assert.doesNotMatch(appSource, /buildAutoSummaryEmergencyText/u);
    assert.doesNotMatch(appSource, /createAutoSummaryFallbackText/u);
    assert.doesNotMatch(appSource, /AUTO SUMMARY OPENAI FALLBACK/u);
    assert.match(appSource, /AUTO_SUMMARY_MODEL_RETRY_MODES/u);
    assert.match(appSource, /resolveAutoSummaryRetryModel/u);
    assert.match(appSource, /consecutiveFailures/u);
    assert.match(appSource, /AUTO_SUMMARY_RETRY_SECONDS/u);
    assert.match(appSource, /slot stays due and the scheduler retries it/u);
});

test('V183 removes the whole-summary 90-second timeout that caused false failures on long chats', () => {
    assert.doesNotMatch(appSource, /AUTO_SUMMARY_AI_TIMEOUT_MS/u);
    assert.match(appSource, /no whole-summary 90 second Promise\.race/u);
    assert.match(appSource, /OPENAI_REQUEST_TIMEOUT_MS = 15 \* 60 \* 1000/u);
});
