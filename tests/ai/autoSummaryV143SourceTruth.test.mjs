import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AUTO_SUMMARY_STALE_GRACE_SECONDS,
  getNextAutoSummaryRunAt,
  resolveAutoSummaryRunWindow,
  shouldSkipStaleAutoSummaryRun,
} from '../../src/features/ai/autoSummaryRouting.js';

const ts = (iso) => Math.floor(Date.parse(iso) / 1000);

test('V143 does not consider 18:00 due at 15:24 Moscow', () => {
  const now = ts('2026-09-03T15:24:00+03:00');
  const next = getNextAutoSummaryRunAt({
    mode: 'full',
    afterTimestamp: now,
    timeZone: 'Europe/Moscow',
  });
  const window = resolveAutoSummaryRunWindow({
    mode: 'full',
    scheduledTimestamp: next,
    timeZone: 'Europe/Moscow',
  });

  assert.equal(window.summaryDate, '2026-09-03');
  assert.equal(window.slotLabel, '18:00');
  assert.equal(next, ts('2026-09-03T18:00:00+03:00'));
  assert.equal(next > now, true);
});

test('V143 skips stale catch-up slots but allows a small scheduler delay', () => {
  assert.equal(AUTO_SUMMARY_STALE_GRACE_SECONDS, 600);
  assert.equal(shouldSkipStaleAutoSummaryRun({
    scheduledTimestamp: ts('2026-09-02T18:00:00+03:00'),
    nowTimestamp: ts('2026-09-03T15:24:00+03:00'),
  }), true);
  assert.equal(shouldSkipStaleAutoSummaryRun({
    scheduledTimestamp: ts('2026-09-03T18:00:00+03:00'),
    nowTimestamp: ts('2026-09-03T18:05:00+03:00'),
  }), false);
});

test('V143 VK auto-summary uses VK source history and source message timestamps', () => {
  const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

  assert.match(source, /primaryVk\.api\.utils\.getServerTime\(\)/u);
  assert.match(source, /client\.api\.messages\.getHistory\(\{/u);
  assert.match(source, /byConversationId\.set\(conversationMessageId/u);
  assert.match(source, /createdAt: Math\.floor\(getRequestDate\(context\)\.getTime\(\) \/ 1000\)/u);
  // V161+ deliberately replaced the old stale-slot discard with catch-up delivery.
  assert.doesNotMatch(source, /AUTO SUMMARY STALE SLOT SKIPPED/u);
  assert.match(source, /AUTO SUMMARY CATCH-UP/u);
  assert.match(source, /Авторезюме — \$\{window\.summaryDate\}, нарастающий итог на \$\{window\.slotLabel\}/u);
});
