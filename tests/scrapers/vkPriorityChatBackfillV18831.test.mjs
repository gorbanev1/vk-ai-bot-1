import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../../src/features/scrapers/sourceConfiguration.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('history backfill is generic and any enabled chat gets a minimum of fifty', () => {
  assert.match(config, /parsedAutoScrollMessages > 0[\s\S]{0,160}Math\.max\(50, parsedAutoScrollMessages\)/u);
  assert.match(chat, /const MIN_HISTORY_BACKFILL_MESSAGES = 50;/u);
  assert.match(chat, /Math\.max\(MIN_HISTORY_BACKFILL_MESSAGES, parsedAutoScrollMessages\)/u);
  assert.doesNotMatch(chat, /const PRIORITY_CHAT_PEER_ID/u);
});

test('history backfill counts only stable CMIDs older than the initial frontier', () => {
  const finite = section(chat, 'async function runFiniteManualPass', 'async function startManualSession');
  assert.match(finite, /initialMinCmid/u);
  assert.match(finite, /hasStableConversationMessageId/u);
  assert.match(finite, /Number\(message\.conversationMessageId\) < initialMinCmid/u);
  assert.match(finite, /historyBackfilledMessages >= historyBackfillTarget/u);
  assert.doesNotMatch(finite, /!initialVisibleIds\.has/u);
});

test('history backfill scrolls slowly and tolerates long VK lazy-load stalls', () => {
  const finite = section(chat, 'async function runFiniteManualPass', 'async function startManualSession');
  assert.match(chat, /const HISTORY_BACKFILL_SCROLL_DELAY_MS = 1800;/u);
  assert.match(finite, /const unchangedLimit = historyBackfillEnabled \? 20 : 5;/u);
  assert.match(finite, /Math\.max\(HISTORY_BACKFILL_SCROLL_DELAY_MS, safeScrollBatchDelayMs\)/u);
  assert.match(finite, /topStallRounds >= \(historyBackfillEnabled \? 4 : 1\)/u);
});

test('finite chat closes after durable cache instead of an artificial sixty-second dwell', () => {
  const finite = section(chat, 'async function runFiniteManualPass', 'async function startManualSession');
  assert.match(finite, /No artificial dwell after the structural\/history target is met/u);
  assert.match(finite, /cacheSource/u);
  const cacheAt = finite.indexOf('cacheSource');
  const closeAt = finite.indexOf('cachedPage.close()');
  const gateAt = finite.indexOf('await processingGate');
  assert.ok(cacheAt >= 0 && closeAt > cacheAt, 'durable cache must exist before closing the browser page');
  assert.ok(gateAt > closeAt, 'processing must not depend on the browser remaining open');
  assert.doesNotMatch(finite, /FINITE_CHAT_MINIMUM_DWELL_MS/u);
});

test('parser-all prioritizes configured history-backfill chats without peer-id hardcode', () => {
  const all = section(app, 'async function startAllManualScraperSources()', 'async function handleManualScraperCommand');
  assert.doesNotMatch(all, /PRIORITY_VK_CHAT_PEER_ID/u);
  assert.match(all, /autoScrollMessages/u);
});

test('VK conversation readiness compares canonical peer id, not URL pathname', () => {
  const pageCheck = section(chat, 'function isConversationPage', 'async function waitForConversationReady');
  assert.match(pageCheck, /normalizeConversationUrl\(conversationUrl\)\.peerId/u);
  assert.match(pageCheck, /normalizeConversationUrl\(page\.url\(\)\)\.peerId/u);
  assert.doesNotMatch(pageCheck, /new URL\(conversationUrl\)\.pathname/u);
});

test('progressive history backfill uses the same initial CMID frontier', () => {
  const progressive = section(chat, 'function startProgressiveBackfill()', 'async function openLivePage()');
  assert.match(progressive, /initialMinCmid/u);
  assert.match(progressive, /hasStableConversationMessageId/u);
  assert.match(progressive, /Number\(message\.conversationMessageId\) < initialMinCmid/u);
  assert.match(progressive, /olderLoaded=/u);
});
