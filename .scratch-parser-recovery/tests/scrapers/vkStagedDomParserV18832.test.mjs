import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const staged = readFileSync(new URL('../../src/platforms/vk/vkStagedDomParser.js', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const publicScraper = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../../src/features/scrapers/sourceConfiguration.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('V188.32 messenger parser has exact, tolerant and semantic stages', () => {
  const messenger = section(staged, 'export function extractVkMessengerDomStaged', 'export function extractVkPublicDomStaged');
  assert.match(messenger, /\.VirtualScrollItem\[data-itemkey\]/u);
  assert.match(messenger, /const stage2Roots/u);
  assert.match(messenger, /const stage3Roots/u);
  assert.match(messenger, /stage = 1/u);
  assert.match(messenger, /stage = 2/u);
  assert.match(messenger, /stage = 3/u);
  assert.match(messenger, /\.ConvoHistory__scrollbar\[data-scrollbar="scrollable"\]/u);
  assert.match(messenger, /\.ForwardedMessageNew/u);
  assert.match(messenger, /\.AttachWallNew/u);
  assert.match(messenger, /PhotoItem/u);
});

test('V188.32 real virtual item key is first-class message CMID', () => {
  const messenger = section(staged, 'export function extractVkMessengerDomStaged', 'export function extractVkPublicDomStaged');
  assert.match(messenger, /dataset\?\.itemkey/u);
  assert.match(messenger, /getAttribute\?\.\('data-itemkey'\)/u);
  assert.match(chat, /oldestCmid=/u);
  assert.match(chat, /cmid > 0 && cmid < initialOldestMessageId/u);
});

test('V188.32 public parser prefers exact post testids and primary attachment poster', () => {
  const pub = section(staged, 'export function extractVkPublicDomStaged');
  assert.match(pub, /\[data-testid="post"\]\[data-post-id\]/u);
  assert.match(pub, /data-post-nesting-lvl/u);
  assert.match(pub, /primary-attachment-image-content/u);
  assert.match(pub, /add\(v, img, 10000\)/u);
  assert.match(pub, /post_date_block_preview/u);
  assert.match(pub, /repostChain/u);
  assert.match(publicScraper, /extractVkPublicDomStaged/u);
  assert.match(publicScraper, /vk-staged-dom-v18832/u);
});

test('V188.32 history backfill is generic and has no hardcoded peer IDs', () => {
  assert.doesNotMatch(chat, /2000000022/u);
  assert.doesNotMatch(app, /2000000022/u);
  assert.doesNotMatch(config, /peerId\s*===\s*2000000022/u);
  assert.match(config, /parsedAutoScrollMessages > 0[\s\S]{0,120}Math\.max\(50, parsedAutoScrollMessages\)/u);
  assert.match(app, /autoScrollMessages[\s\S]{0,120}> 0/u);
});

test('V188.32 finite pass slowly loads older CMIDs beyond initial snapshot and keeps minute dwell', () => {
  const finite = section(chat, 'async function runFiniteManualPass', 'async function startManualSession');
  assert.match(chat, /const STRICT_BACKFILL_SCROLL_DELAY_MS = 1800;/u);
  assert.match(chat, /const FINITE_CHAT_MINIMUM_DWELL_MS = 60_000;/u);
  assert.match(finite, /initialOldestMessageId/u);
  assert.match(finite, /historyBackfilledMessages/u);
  assert.match(finite, /historyBackfilledMessages >= historyBackfillTarget/u);
  assert.match(finite, /const unchangedLimit = strictBackfillEnabled \? 20 : 5;/u);
  assert.match(finite, /FINITE_CHAT_MINIMUM_DWELL_MS/u);
});
