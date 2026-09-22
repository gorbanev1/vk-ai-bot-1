import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    addCalendarDays,
    calendarWeekMonthSegmentForDay,
    calendarWeekStart,
    calendarWeekEndExclusive,
    nextCalendarMonthStart,
} from '../../src/features/ai/calendarSummaryRollup.js';
import { createHierarchicalSummaryStateStore } from '../../src/infrastructure/database/hierarchicalSummaryStateStore.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../../src/infrastructure/database/hierarchicalSummaryStateStore.js', import.meta.url), 'utf8');

test('V188.43 calendar boundaries are day 24:00, Sunday 24:00 and last-day 24:00', () => {
    assert.equal(addCalendarDays('2026-09-11', 1), '2026-09-12');
    assert.equal(calendarWeekStart('2026-09-06'), '2026-08-31');
    assert.equal(calendarWeekEndExclusive('2026-08-31'), '2026-09-07');
    assert.equal(nextCalendarMonthStart('2026-09'), '2026-10-01');

    assert.match(appSource, /daily=00:00-local/u);
    assert.match(appSource, /weekly=Sunday-24:00\/Monday-00:00-local/u);
    assert.match(appSource, /monthly=last-day-24:00\/next-month-00:00-local/u);
    assert.match(appSource, /CALENDAR_SUMMARY_MIDNIGHT_TICK_MINUTES/u);
    assert.doesNotMatch(appSource, /HIERARCHICAL_PERIOD_SEND_HOUR = 20/u);
});

test('V188.43 week is cut at month boundary so a calendar month can consume only weekly-layer inputs', () => {
    const august = calendarWeekMonthSegmentForDay('2026-08-31');
    const september = calendarWeekMonthSegmentForDay('2026-09-01');

    assert.deepEqual(august, {
        weekKey: '2026-08-31',
        monthKey: '2026-08',
        segmentKey: '2026-08-31::2026-08',
        startDate: '2026-08-31',
        endDate: '2026-09-01',
    });
    assert.deepEqual(september, {
        weekKey: '2026-08-31',
        monthKey: '2026-09',
        segmentKey: '2026-08-31::2026-09',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
    });
});

test('V188.43 separate daily/weekly/monthly tables and promotion ledger are durable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v18843-rollup-'));
    const path = join(dir, 'summary.sqlite');
    try {
        const store = createHierarchicalSummaryStateStore({ databasePath: path });
        const daily1 = store.saveDailyRevisionWithMessages({
            peerId: 2000000006,
            dayKey: '2026-09-01',
            startAt: 100,
            endAt: 200,
            inputHash: 'd1',
            summaryText: 'day one',
            model: 'mini',
            messageCount: 2,
        }, [
            { messageKey: '2:1', peerId: 2000000006, contentHash: 'm1', sourcePeerId: 2, conversationMessageId: 1, createdAt: 110 },
            { messageKey: '2:2', peerId: 2000000006, contentHash: 'm2', sourcePeerId: 2, conversationMessageId: 2, createdAt: 120 },
        ]);
        assert.equal(daily1.revision, 1);
        assert.equal(store.getMessageState('2:1')?.nodeKey, 'daily:2026-09-01:1');
        assert.equal(store.getUnconsumedDailySummaries(2000000006).length, 1);

        const weekly1 = store.saveWeeklyRevisionWithSources({
            peerId: 2000000006,
            weekKey: '2026-08-31',
            monthKey: '2026-09',
            segmentKey: '2026-08-31::2026-09',
            startAt: 100,
            endAt: 700,
            inputHash: 'w1',
            summaryText: 'week segment',
            model: 'mini',
            sourceCount: 1,
            messageCount: 2,
        }, [daily1]);
        assert.equal(weekly1.revision, 1);
        assert.equal(store.getUnconsumedDailySummaries(2000000006).length, 0);
        assert.equal(store.getUnconsumedWeeklySummaries(2000000006).length, 1);

        const monthly1 = store.saveMonthlyRevisionWithSources({
            peerId: 2000000006,
            monthKey: '2026-09',
            startAt: 100,
            endAt: 900,
            inputHash: 'mo1',
            summaryText: 'month',
            model: 'mini',
            sourceCount: 1,
            messageCount: 2,
        }, [weekly1]);
        assert.equal(monthly1.revision, 1);
        assert.equal(store.getUnconsumedWeeklySummaries(2000000006).length, 0);
        assert.equal(store.getMonthlySummaries(2000000006, '2026-09').length, 1);
        store.close();

        const reopened = createHierarchicalSummaryStateStore({ databasePath: path });
        assert.equal(reopened.getDailySummaries(2000000006, '2026-09-01').length, 1);
        assert.equal(reopened.getWeeklySummaries(2000000006, '2026-08-31').length, 1);
        assert.equal(reopened.getMonthlySummaries(2000000006, '2026-09').length, 1);
        reopened.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('V188.43 late message becomes a delta revision and never reconsumes old daily/weekly inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v18843-late-'));
    let store = null;
    try {
        store = createHierarchicalSummaryStateStore({ directory: dir });
        const d1 = store.saveDailyRevisionWithMessages({
            peerId: 2000000006, dayKey: '2026-09-01', startAt: 1, endAt: 2,
            inputHash: 'day-base', summaryText: 'base day', model: 'mini', messageCount: 10,
        }, [{ messageKey: '2:10', peerId: 2000000006, contentHash: 'base-message', sourcePeerId: 2, conversationMessageId: 10, createdAt: 1 }]);
        const w1 = store.saveWeeklyRevisionWithSources({
            peerId: 2000000006, weekKey: '2026-08-31', monthKey: '2026-09', segmentKey: '2026-08-31::2026-09',
            startAt: 1, endAt: 7, inputHash: 'week-base', summaryText: 'base week', model: 'mini', sourceCount: 1, messageCount: 10,
        }, [d1]);
        store.saveMonthlyRevisionWithSources({
            peerId: 2000000006, monthKey: '2026-09', startAt: 1, endAt: 30,
            inputHash: 'month-base', summaryText: 'base month', model: 'mini', sourceCount: 1, messageCount: 10,
        }, [w1]);

        const d2 = store.saveDailyRevisionWithMessages({
            peerId: 2000000006, dayKey: '2026-09-01', startAt: 1, endAt: 2,
            inputHash: 'day-late', summaryText: 'late-only day delta', model: 'mini', messageCount: 1,
        }, [{ messageKey: '9:999', peerId: 2000000006, contentHash: 'late-message', sourcePeerId: 9, conversationMessageId: 999, createdAt: 1 }]);
        assert.equal(d2.revision, 2);
        assert.deepEqual(store.getUnconsumedDailySummaries(2000000006).map((row) => row.revision), [2]);

        const w2 = store.saveWeeklyRevisionWithSources({
            peerId: 2000000006, weekKey: '2026-08-31', monthKey: '2026-09', segmentKey: '2026-08-31::2026-09',
            startAt: 1, endAt: 7, inputHash: 'week-late', summaryText: 'late-only week delta', model: 'mini', sourceCount: 1, messageCount: 1,
        }, [d2]);
        assert.equal(w2.revision, 2);
        assert.equal(store.getUnconsumedDailySummaries(2000000006).length, 0);
        assert.deepEqual(store.getUnconsumedWeeklySummaries(2000000006).map((row) => row.revision), [2]);

        const m2 = store.saveMonthlyRevisionWithSources({
            peerId: 2000000006, monthKey: '2026-09', startAt: 1, endAt: 30,
            inputHash: 'month-late', summaryText: 'late-only month delta', model: 'mini', sourceCount: 1, messageCount: 1,
        }, [w2]);
        assert.equal(m2.revision, 2);
        assert.equal(store.getUnconsumedWeeklySummaries(2000000006).length, 0);
    } finally {
        store?.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('V188.43 automatic maintenance no longer calls the legacy raw all-history hierarchy', () => {
    const start = appSource.indexOf('async function runHierarchicalSummaryMaintenance(');
    const end = appSource.indexOf('async function runHierarchicalSummaryPeriodTick()', start);
    const body = appSource.slice(start, end);
    assert.match(body, /runCalendarSummaryMaintenanceForPeer/u);
    assert.doesNotMatch(body, /ensureHierarchicalChatMemory/u);

    assert.match(appSource, /pipeline=raw-once>daily>week-segment>month/u);
    assert.match(appSource, /inputTokenBudget = SUMMARY_COMMAND_INPUT_TOKEN_BUDGET/u);
    assert.match(appSource, /24_000/u);
    assert.match(appSource, /SUMMARY_COMMAND_MERGE_CHARS[\s\S]*48_000/u);
    assert.match(appSource, /splitStableSummaryMessageBatches\(entries, \{ inputTokenBudget \}\)/u);
    assert.match(appSource, /LEGACY_AUTO_SUMMARY_SCHEDULER_ENABLED[\s\S]*false/u);
    assert.match(appSource, /if \(LEGACY_AUTO_SUMMARY_SCHEDULER_ENABLED\) \{[\s\S]*runAutoSummaryTick\(\{ startupCatchUp: true \}\)/u);
});

test('V188.43 month promotion consumes weekly table only; all-time uses non-overlapping month/week/day layers', () => {
    const monthlyStart = appSource.indexOf('async function promoteCalendarWeeklyToMonthly(');
    const monthlyEnd = appSource.indexOf('function composeRevisionText(', monthlyStart);
    const monthlyBody = appSource.slice(monthlyStart, monthlyEnd);
    assert.match(monthlyBody, /getHierarchyUnconsumedWeeklySummaries/u);
    assert.match(monthlyBody, /saveHierarchyMonthlyRevisionWithSources/u);
    assert.doesNotMatch(monthlyBody, /loadLinkedSummaryHistory|createOpenAISummary/u);

    const allStart = appSource.indexOf('async function createCalendarAllTimeSummary(');
    const allEnd = appSource.indexOf('let hierarchicalSummaryMaintenanceRunning', allStart);
    const allBody = appSource.slice(allStart, allEnd);
    assert.match(allBody, /getHierarchyMonthlySummaries/u);
    assert.match(allBody, /getHierarchyUnconsumedWeeklySummaries/u);
    assert.match(allBody, /getHierarchyUnconsumedDailySummaries/u);
    assert.doesNotMatch(allBody, /loadLinkedSummaryHistory/u);
});

test('V188.43 paid raw coverage and rollup promotions are immutable in schema', () => {
    assert.match(storeSource, /ON CONFLICT\(message_key\) DO NOTHING/u);
    assert.match(storeSource, /CREATE TABLE IF NOT EXISTS hierarchy_daily_summaries/u);
    assert.match(storeSource, /CREATE TABLE IF NOT EXISTS hierarchy_weekly_summaries/u);
    assert.match(storeSource, /CREATE TABLE IF NOT EXISTS hierarchy_monthly_summaries/u);
    assert.match(storeSource, /UNIQUE \(peer_id, target_level, source_level, source_period_key, source_revision\)/u);
});
