import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    coalesceOverdueAutoSummaryRunAt,
    parseAutoSummaryCommand,
} from '../../src/features/ai/autoSummaryRouting.js';
import { createAutoSummaryStateStore } from '../../src/infrastructure/database/autoSummaryStateStore.js';

const tz = 'Europe/Moscow';
const ts = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('V161 never drops an overdue auto-summary slot and collapses downtime to latest cumulative slot', () => {
    const result = coalesceOverdueAutoSummaryRunAt({
        mode: 'full',
        nextRunAt: ts('2026-09-06T10:00:00Z'), // 13:00 MSK
        nowTimestamp: ts('2026-09-06T18:05:00Z'), // 21:05 MSK
        timeZone: tz,
    });
    assert.equal(result.scheduledAt, ts('2026-09-06T18:00:00Z')); // 21:00 MSK
    assert.equal(result.skippedSlots, 2); // 18:00 + 21:00 replace stale 13:00

    const justLate = coalesceOverdueAutoSummaryRunAt({
        mode: 'evening',
        nextRunAt: ts('2026-09-06T15:00:00Z'), // 18:00 MSK
        nowTimestamp: ts('2026-09-06T15:47:00Z'),
        timeZone: tz,
    });
    assert.equal(justLate.scheduledAt, ts('2026-09-06T15:00:00Z'));
    assert.equal(justLate.skippedSlots, 0);
});

test('V161 supports an immediate control run command', () => {
    assert.equal(parseAutoSummaryCommand('авторезюме сейчас').action, 'run-now');
    assert.equal(parseAutoSummaryCommand('Гигорейв авторезюме тест').action, 'run-now');
});

test('V161 persists auto-summary delivery health separately from settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v161-autosummary-'));
    try {
        const store = createAutoSummaryStateStore({ directory: dir });
        store.saveHealth({
            peerId: 2_000_000_027,
            lastAttemptAt: 100,
            lastSuccessAt: 90,
            lastError: 'temporary send error',
            consecutiveFailures: 2,
        });
        assert.deepEqual(store.getHealth(2_000_000_027), {
            peerId: 2_000_000_027,
            lastAttemptAt: 100,
            lastSuccessAt: 90,
            lastError: 'temporary send error',
            consecutiveFailures: 2,
        });
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('V161 runtime keeps a failed slot due, retries quickly, and can fall back to local VK history/alternate endpoint', () => {
    const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /AUTO SUMMARY STALE SLOT SKIPPED/u);
    assert.match(source, /AUTO SUMMARY CATCH-UP/u);
    assert.match(source, /fallback-local/u);
    assert.match(source, /getVkClientsForAutoSummary/u);
    assert.match(source, /AUTO_SUMMARY_RETRY_SECONDS/u);
    assert.match(source, /lastSuccessAt/u);
    assert.match(source, /авторезюме сейчас/u);
});
