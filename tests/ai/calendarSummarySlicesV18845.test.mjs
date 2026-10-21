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

test('calendar fixed intraday slots include overnight and 22:30 tail batches', () => {
  assert.deepEqual(CALENDAR_SUMMARY_SLICE_LABELS, ['03:00', '09:00', '12:00', '15:00', '18:00', '21:00', '22:30', '23:59']);
  assert.deepEqual(getAutoSummaryScheduleSlots('full'), CALENDAR_SUMMARY_SLICE_LABELS);
  assert.equal(formatAutoSummaryMode(), '03:00, 09:00, 12:00, 15:00, 18:00, 21:00, 22:30 и 23:59');
  assert.equal(parseAutoSummaryCommand('резюмирование вкл').action, 'enable');
  assert.equal(parseAutoSummaryCommand('резюмирование выкл').action, 'disable');
  assert.equal(parseAutoSummaryCommand('резюмирование статус').action, 'status');
});

test('calendar slices cover the full day without gaps; 23:59 closes nominally but owns the last minute', () => {
  const rows = CALENDAR_SUMMARY_SLICE_LABELS.map((label) => {
    const slot = { label, startMinute: ({'03:00':0,'09:00':180,'12:00':540,'15:00':720,'18:00':900,'21:00':1080,'22:30':1260,'23:59':1350})[label], endMinute: ({'03:00':180,'09:00':540,'12:00':720,'15:00':900,'18:00':1080,'21:00':1260,'22:30':1350,'23:59':1440})[label] };
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
    '2026-09-12T00:00:00.000Z', // 03:00 Moscow
    '2026-09-12T06:00:00.000Z', // 09:00
    '2026-09-12T09:00:00.000Z', // 12:00
    '2026-09-12T12:00:00.000Z', // 15:00
    '2026-09-12T15:00:00.000Z', // 18:00
    '2026-09-12T18:00:00.000Z', // 21:00
    '2026-09-12T19:30:00.000Z', // 22:30
    '2026-09-12T20:59:00.000Z', // 23:59
    '2026-09-12T21:00:00.000Z', // 00:00 next day
    '2026-09-12T08:00:00.000Z', // 11:00 long-period rollup
    '2026-09-12T09:00:00.000Z', // 12:00 annual rollup
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

test('intraday calendar batches declare the 60 percent target and eight paragraphs in the prompt without post-generation clipping', () => {
  assert.match(appSource, /const CALENDAR_SUMMARY_INTRADAY_MAX_CHARS = 1_296/u);
  assert.match(appSource, /const CALENDAR_SUMMARY_INTRADAY_MAX_PARAGRAPHS = 8/u);
  assert.doesNotMatch(appSource, /function clampCalendarIntradayBatchSummary/u);
  assert.match(appSource, /Допустимо максимум \$\{getAutoSummaryLimit\('intraday_paragraphs'\)\} абзацев и ориентир до \$\{getAutoSummaryLimit\('intraday_chars'\)\} знаков/u);
  assert.match(appSource, /summaryText: compactSummary/u);
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
  assert.match(deliveryBlock, /deliverCalendarDailyIfDue/u);
});

test('calendar delivery keeps text summary when optional illustration fails', () => {
  const start = appSource.indexOf('async function sendScheduledAutoSummary');
  const end = appSource.indexOf('const autoSummaryImageJobs', start);
  const block = appSource.slice(start, end);
  assert.match(block, /getAutoSummaryIllustration\(settings\.peerId, text, \{ periodPrompt: illustrationPrompt \}\)/u);
  assert.match(block, /AUTO SUMMARY IMAGE OPTIONAL FAILURE/u);
  assert.match(block, /await sendScheduledTextMessage\(settings, \[.*String\(text\)/u);
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
