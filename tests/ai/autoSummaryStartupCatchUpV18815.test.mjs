import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    resolveAutoSummaryRunWindow,
    resolveStartupAutoSummaryCatchUpWindow,
} from '../../src/features/ai/autoSummaryRouting.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const tz = 'Europe/Moscow';
const ts = (value) => Math.floor(Date.parse(value) / 1000);

test('V188.15 startup catch-up extends a missed cumulative slot to boot time', () => {
    const scheduled = ts('2026-09-09T13:00:00+03:00');
    const base = resolveAutoSummaryRunWindow({
        mode: 'full',
        scheduledTimestamp: scheduled,
        timeZone: tz,
    });
    const caught = resolveStartupAutoSummaryCatchUpWindow({
        mode: 'full',
        window: base,
        nowTimestamp: ts('2026-09-09T14:37:00+03:00'),
        timeZone: tz,
    });

    assert.equal(caught.startTimestamp, ts('2026-09-09T06:00:00+03:00'));
    assert.equal(caught.scheduledEndTimestamp, scheduled);
    assert.equal(caught.endTimestamp, ts('2026-09-09T14:37:00+03:00'));
    assert.equal(caught.startupCatchUp, true);
    assert.equal(caught.catchUpExtended, true);
});

test('V188.15 startup catch-up never crosses next 06:00 bot-day boundary', () => {
    const base = resolveAutoSummaryRunWindow({
        mode: 'full',
        scheduledTimestamp: ts('2026-09-08T23:00:00+03:00'),
        timeZone: tz,
    });
    const caught = resolveStartupAutoSummaryCatchUpWindow({
        mode: 'full',
        window: base,
        nowTimestamp: ts('2026-09-09T10:18:00+03:00'),
        timeZone: tz,
    });

    assert.equal(caught.summaryDate, '2026-09-08');
    assert.equal(caught.endTimestamp, ts('2026-09-09T06:00:00+03:00'));
});

test('V188.15 day-only catch-up keeps its closed 06:00→06:00 period', () => {
    const base = resolveAutoSummaryRunWindow({
        mode: 'day',
        scheduledTimestamp: ts('2026-09-09T06:00:00+03:00'),
        timeZone: tz,
    });
    const caught = resolveStartupAutoSummaryCatchUpWindow({
        mode: 'day',
        window: base,
        nowTimestamp: ts('2026-09-09T10:18:00+03:00'),
        timeZone: tz,
    });

    assert.equal(caught.endTimestamp, ts('2026-09-09T06:00:00+03:00'));
    assert.equal(caught.catchUpExtended, false);
});

test('V188.15 first auto-summary tick is explicitly marked as startup catch-up and history cap matches 100k messages', () => {
    assert.match(appSource, /runAutoSummaryTick\(\{\s*startupCatchUp:\s*true\s*\}\)/u);
    assert.match(appSource, /AUTO SUMMARY STARTUP CATCH-UP/u);
    assert.match(appSource, /resolveStartupAutoSummaryCatchUpWindow/u);
    assert.match(appSource, /AUTO_SUMMARY_VK_HISTORY_MAX_PAGES\s*=\s*Math\.ceil\(\s*AUTO_SUMMARY_MAX_MESSAGES\s*\/\s*AUTO_SUMMARY_VK_HISTORY_PAGE_SIZE\s*\)/u);
});
