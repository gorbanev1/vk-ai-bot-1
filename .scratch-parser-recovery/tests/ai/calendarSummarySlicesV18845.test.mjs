import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CALENDAR_SUMMARY_SLICE_LABELS,
  calendarSummarySliceBounds,
  calendarSummarySliceForTimestamp,
  shouldRunCalendarSliceBoundaryTick,
} from '../../src/features/ai/calendarSummarySlices.js';
import { createHierarchicalSummaryStateStore } from '../../src/infrastructure/database/hierarchicalSummaryStateStore.js';
import { parseAutoSummaryCommand, getAutoSummaryScheduleSlots, formatAutoSummaryMode } from '../../src/features/ai/autoSummaryRouting.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../../src/infrastructure/database/hierarchicalSummaryStateStore.js', import.meta.url), 'utf8');

const TZ = 'Europe/Moscow';

test('V188.45 fixed intraday slots are 09/13/15/18/21/23:59', () => {
  assert.deepEqual(CALENDAR_SUMMARY_SLICE_LABELS, ['09:00', '13:00', '15:00', '18:00', '21:00', '23:59']);
  assert.deepEqual(getAutoSummaryScheduleSlots('full'), CALENDAR_SUMMARY_SLICE_LABELS);
  assert.equal(formatAutoSummaryMode(), '09:00, 13:00, 15:00, 18:00, 21:00 и 23:59');
  assert.equal(parseAutoSummaryCommand('резюмирование вкл').action, 'enable');
  assert.equal(parseAutoSummaryCommand('резюмирование выкл').action, 'disable');
  assert.equal(parseAutoSummaryCommand('резюмирование статус').action, 'status');
});

test('V188.45 slices cover the full day without gaps; 23:59 closes nominally but owns the last minute', () => {
  const rows = CALENDAR_SUMMARY_SLICE_LABELS.map((label) => {
    const slot = { label, startMinute: ({'09:00':0,'13:00':540,'15:00':780,'18:00':900,'21:00':1080,'23:59':1260})[label], endMinute: ({'09:00':540,'13:00':780,'15:00':900,'18:00':1080,'21:00':1260,'23:59':1440})[label] };
    return calendarSummarySliceBounds('2026-09-12', slot, TZ);
  });
  for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i - 1].endAt, rows[i].startAt);
  assert.equal(rows.at(-1).endAt - rows[0].startAt, 24 * 60 * 60);
  assert.equal(rows.at(-1).endAt - rows.at(-1).closeAt, 60);

  const at235930 = rows.at(-1).closeAt + 30;
  const slice = calendarSummarySliceForTimestamp(at235930, '2026-09-12', TZ);
  assert.equal(slice.slotLabel, '23:59');
});

test('V188.45 boundary trigger includes all public slots and midnight rollup', () => {
  for (const iso of [
    '2026-09-12T06:00:00.000Z', // 09:00 Moscow
    '2026-09-12T10:00:00.000Z', // 13:00
    '2026-09-12T12:00:00.000Z', // 15:00
    '2026-09-12T15:00:00.000Z', // 18:00
    '2026-09-12T18:00:00.000Z', // 21:00
    '2026-09-12T20:59:00.000Z', // 23:59
    '2026-09-12T21:00:00.000Z', // 00:00 next day
  ]) assert.equal(shouldRunCalendarSliceBoundaryTick(new Date(iso), TZ), true, iso);
});

test('V188.45 durable batch table marks raw once and promotes batch->day atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gigorave-v18845-batch-'));
  try {
    const store = createHierarchicalSummaryStateStore({ directory: dir });
    const b1 = store.saveBatchRevisionWithMessages({
      peerId: 2000000006, dayKey: '2026-09-12', slotLabel: '09:00', sliceKey: '2026-09-12@09:00',
      startAt: 100, endAt: 200, inputHash: 'b1', summaryText: 'batch one', model: 'mini', messageCount: 2,
    }, [
      { messageKey: '6:1', peerId: 2000000006, contentHash: 'h1', sourcePeerId: 6, conversationMessageId: 1, createdAt: 110 },
      { messageKey: '6:2', peerId: 2000000006, contentHash: 'h2', sourcePeerId: 6, conversationMessageId: 2, createdAt: 120 },
    ]);
    assert.equal(b1.revision, 1);
    assert.equal(store.getMessageState('6:1').nodeKey, 'batch:2026-09-12@09:00:1');
    assert.equal(store.getUnconsumedBatchSummaries(2000000006).length, 1);

    const d1 = store.saveDailyRevisionWithSources({
      peerId: 2000000006, dayKey: '2026-09-12', startAt: 100, endAt: 999,
      inputHash: 'd1', summaryText: 'day from batches', model: 'mini', messageCount: 2,
    }, [b1]);
    assert.equal(d1.revision, 1);
    assert.equal(store.getUnconsumedBatchSummaries(2000000006).length, 0);
    assert.equal(store.getUnconsumedDailySummaries(2000000006).length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V188.45 code enforces summary reuse and 3000 raw messages per leaf/request guard', () => {
  assert.match(storeSource, /CREATE TABLE IF NOT EXISTS hierarchy_batch_summaries/u);
  assert.match(storeSource, /target_level = 'day'[\s\S]*source_level = 'batch'/u);
  assert.match(appSource, /SUMMARY_COMMAND_BATCH_MESSAGES = 3_000/u);
  assert.match(appSource, /SUMMARY_USER_RAW_MESSAGE_HARD_LIMIT = 3_000/u);
  assert.match(appSource, /pipeline=raw-once>intraday-batch>daily>week-segment>month/u);
  assert.match(appSource, /getHierarchyUnconsumedBatchSummaries/u);
  assert.match(appSource, /saveHierarchyDailyRevisionWithSources/u);
  assert.doesNotMatch(appSource.slice(appSource.indexOf('async function promoteCalendarBatchToDaily'), appSource.indexOf('async function promoteCalendarDailyToWeekly')), /loadLinkedSummaryHistory|createOpenAISummary/u);
});

test('V188.45 accumulation runs for all stored group chats while delivery requires durable enabled setting', () => {
  assert.match(appSource, /getStoredGroupPeerIds\(\)/u);
  assert.match(appSource, /background accumulation is not tied to delivery settings/u);
  assert.match(appSource, /function getCalendarSummaryDeliverySettings\(peerId\)[\s\S]*settings\?\.enabled/u);
  assert.match(appSource, /Настройка сохранена в SQLite и переживает перезапуск/u);
  const deliveryStart = appSource.indexOf('async function deliverRecentCalendarSummaries');
  const deliveryEnd = appSource.indexOf('async function runCalendarSummaryMaintenanceForPeer', deliveryStart);
  const deliveryBlock = appSource.slice(deliveryStart, deliveryEnd);
  assert.match(deliveryBlock, /deliverCalendarBatchIfDue/u);
  assert.doesNotMatch(deliveryBlock, /deliverCalendarDailyIfDue|deliverCalendarWeekIfDue|deliverCalendarMonthIfDue/u);
});


test('V188.45 full-chat analysis is summary-first and never streams the full raw database to AI', () => {
  const start = appSource.indexOf('async function analyzeAllChatMessages({');
  const end = appSource.indexOf('async function sendChatDatabaseAnswer(', start);
  const block = appSource.slice(start, end);
  assert.match(block, /createCalendarAllTimeSummary\(context\.peerId, model\)/u);
  assert.match(block, /collectBoundedUncoveredCalendarTail/u);
  assert.match(block, /SUMMARY_USER_RAW_MESSAGE_HARD_LIMIT/u);
  assert.doesNotMatch(block, /formatChatDatabaseTranscript\(messages\)/u);
  assert.match(block, /formatChatDatabaseTranscript\(uncovered\.messages\)/u);
  assert.doesNotMatch(appSource, /Проанализирована вся база этой беседы/u);
});

test('V188.45 search can scan every match but direct LLM retrieval is capped at 3000 raw messages', () => {
  const start = appSource.indexOf('async function trySendDatabaseMessageRetrievalAnswer({');
  const end = appSource.indexOf('// Backward-compatible wrapper', start);
  const block = appSource.slice(start, end);
  assert.match(block, /const llmMatches = unique\.length > SUMMARY_USER_RAW_MESSAGE_HARD_LIMIT/u);
  assert.match(block, /unique\.slice\(-SUMMARY_USER_RAW_MESSAGE_HARD_LIMIT\)/u);
  assert.match(block, /В ИИ напрямую передано raw/u);
});

test('V188.45 participant database analysis shares one 3000-message raw budget', () => {
  assert.match(appSource, /PARTICIPANT_OWN_RAW_MESSAGE_BUDGET = 2_000/u);
  assert.match(appSource, /PARTICIPANT_MENTION_RAW_MESSAGE_BUDGET =[\s\S]*SUMMARY_USER_RAW_MESSAGE_HARD_LIMIT - PARTICIPANT_OWN_RAW_MESSAGE_BUDGET/u);
  assert.match(appSource, /capParticipantContextWindowsByMessageCount/u);
});
