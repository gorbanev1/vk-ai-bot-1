import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHierarchicalSummaryStateStore } from '../../src/infrastructure/database/hierarchicalSummaryStateStore.js';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const databaseSource = readFileSync(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');

test('V188 hierarchy state survives reopen with leaf ledger, root and period delivery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v188-hierarchy-'));
    const dbPath = join(dir, 'hierarchy.sqlite');
    try {
        const first = createHierarchicalSummaryStateStore({ databasePath: dbPath });
        first.saveNode({
            nodeKey: 'leaf-a', peerId: 2000000006, level: 0, kind: 'leaf',
            startAt: 10, endAt: 20, messageCount: 2, estimatedTokens: 100,
            inputHash: 'hash-a', model: 'gpt-test', summaryText: 'leaf summary',
            childKeys: ['2000000002:1', '2000000002:2'],
        });
        first.saveMessageState({
            messageKey: '2000000002:1', peerId: 2000000006, contentHash: 'm1', nodeKey: 'leaf-a',
            sourcePeerId: 2000000002, conversationMessageId: 1, createdAt: 10,
        });
        first.savePeerState({ peerId: 2000000006, rootNodeKey: 'leaf-a', bootstrapComplete: true, lastScanAt: 30 });
        first.savePeriod({
            peerId: 2000000006, periodType: 'week', periodKey: '2026-09-06', startAt: 1, endAt: 2,
            inputHash: 'week-hash', summaryText: 'week summary', model: 'gpt-test', messageCount: 77,
        });
        first.markPeriodDelivered(2000000006, 'week', '2026-09-06', 50);
        first.close();

        const second = createHierarchicalSummaryStateStore({ databasePath: dbPath });
        assert.equal(second.getNode('leaf-a')?.summaryText, 'leaf summary');
        assert.equal(second.getMessageState('2000000002:1')?.nodeKey, 'leaf-a');
        assert.equal(second.getPeerState(2000000006)?.bootstrapComplete, true);
        assert.equal(second.getPeriod(2000000006, 'week', '2026-09-06')?.deliveredAt, 50);
        second.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('V188 uses 90 percent adaptive context budget with context split fallback', () => {
    assert.match(source, /HIERARCHICAL_SUMMARY_CONTEXT_TOKENS[\s\S]*128_000/u);
    assert.match(source, /HIERARCHICAL_SUMMARY_CONTEXT_RATIO[\s\S]*0\.90/u);
    assert.match(source, /HIERARCHICAL_SUMMARY_INPUT_TOKEN_BUDGET/u);
    assert.match(source, /estimateSummaryTokens/u);
    assert.match(source, /\[SUMMARY CONTEXT SPLIT\]/u);
    assert.match(source, /\[HIERARCHY CONTEXT SPLIT\]/u);
});

test('V188 builds durable all-time hierarchy from linked VK archive plus current messages', () => {
    assert.match(databaseSource, /export function getVkMessageArchiveMessages\(peerId\)/u);
    assert.match(source, /function loadLinkedSummaryHistory\(peerId\)/u);
    assert.match(source, /getVkMessageArchiveMessages\(canonicalPeerId\)/u);
    assert.match(source, /getHierarchyMessageStates/u);
    assert.match(source, /bootstrapComplete/u);
    assert.match(source, /rebuildHierarchicalChatRoot/u);
    assert.match(source, /HIERARCHICAL_SUMMARY_TREE_FANOUT = 12/u);
});

test('V188.43 daily/weekly/monthly accumulation is default-on and delivered from durable calendar state', () => {
    assert.match(source, /HIERARCHICAL_SUMMARY_AUTO_ENABLED', true/u);
    assert.match(source, /buildCalendarDailyRevisions/u);
    assert.match(source, /promoteCalendarDailyToWeekly/u);
    assert.match(source, /promoteCalendarWeeklyToMonthly/u);
    assert.match(source, /getHierarchyRollupDelivery/u);
    assert.match(source, /markHierarchyRollupDelivered/u);
    assert.match(source, /daily=00:00-local/u);
    assert.match(source, /weekly=Sunday-24:00\/Monday-00:00-local/u);
    assert.match(source, /monthly=last-day-24:00\/next-month-00:00-local/u);
});

test('V188.43 large explicit summaries are owner-only and all-time uses reusable paid rollup layers', () => {
    assert.match(source, /HIERARCHICAL_SUMMARY_LARGE_OWNER_THRESHOLD = 5_000/u);
    assert.match(source, /range\?\.unit === 'all'/u);
    assert.match(source, /createCalendarAllTimeSummary\(context\.peerId, model\)/u);
    assert.match(source, /getHierarchyMonthlySummaries\(peerId\)/u);
    assert.match(source, /getHierarchyUnconsumedWeeklySummaries\(peerId\)/u);
    assert.match(source, /getHierarchyUnconsumedDailySummaries\(peerId\)/u);
    assert.match(source, /🧠 Суть всей сохранённой истории чата/u);
});

test('V188 legacy scheduled auto-summary delegates to adaptive cached summary path', () => {
    const start = source.indexOf('async function createAutoSummaryText({');
    const end = source.indexOf('function validateAutoSummaryForDelivery', start);
    const body = source.slice(start, end);
    assert.match(body, /return createOpenAISummary/u);
    assert.doesNotMatch(body, /SUMMARY_CHUNK_SIZE/u);
});
