import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { shouldPreserveStoredEventsOnEmptyReparse } from '../../src/features/events/sourceEventPersistence.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const tg = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

test('V188.28 empty repeat parse never erases already accepted source events', () => {
  assert.equal(shouldPreserveStoredEventsOnEmptyReparse({ previousEventCount: 1, acceptedEventCount: 0 }), true);
  assert.equal(shouldPreserveStoredEventsOnEmptyReparse({ previousEventCount: 5, acceptedEventCount: 0 }), true);
  assert.equal(shouldPreserveStoredEventsOnEmptyReparse({ previousEventCount: 0, acceptedEventCount: 0 }), false);
  assert.equal(shouldPreserveStoredEventsOnEmptyReparse({ previousEventCount: 1, acceptedEventCount: 1 }), false);
  assert.match(vk, /shouldPreserveStoredEventsOnEmptyReparse\(\{/u);
  assert.match(tg, /shouldPreserveStoredEventsOnEmptyReparse\(\{/u);
  assert.match(chat, /shouldPreserveStoredEventsOnEmptyReparse\(\{/u);
});

test('V188.28 VK real post photo > exact DOM media > link preview/logo', () => {
  const start = app.indexOf('export function chooseVkPublicPostImageUrls');
  const end = app.indexOf('async function hydrateVkPublicPostsWithApiMedia', start);
  const block = app.slice(start, end);
  assert.match(block, /if \(real\.length\) return \{ imageUrls: real, confidence: 'wall-photo' \}/u);
  assert.match(block, /if \(dom\.length\) return \{ imageUrls: dom, confidence: 'dom-post-media' \}/u);
  assert.match(block, /const previews = extractVkWallPreviewPhotoUrls/u);
  assert.match(app, /imageUrls: selectedImages\.imageUrls/u);
  assert.match(app, /imageConfidence: selectedImages\.confidence/u);
});

test('V188.28 exact VK maintenance does not let API preview override browser poster', () => {
  assert.match(app, /exactVkPost\.imageConfidence === 'wall-photo'/u);
  const start = app.indexOf('async function reparseStoredEventSourceUrl(');
  const end = app.indexOf('async function reparseAllStoredEventLinks', start);
  const block = app.slice(start, end);
  assert.match(block, /mergeManualExactVkPostSources\(/u);
  assert.doesNotMatch(block, /if \(exactVkPost\) selectedPost = exactVkPost;/u);
});

test('V188.28 generic exact-page image extraction rejects avatar/logo UI', () => {
  assert.match(browser, /avatar\|profile\|emoji\|reaction\|sticker\|icon\|badge\|logo\|favicon\|smile/u);
  assert.match(browser, /isUiMarker/u);
  assert.match(browser, /hasPhotoAnchor/u);
});

test('V188.28 startup strict check is audit-only, not destructive cleanup', () => {
  assert.match(app, /\[STRICT EVENT AUDIT NON-DESTRUCTIVE\]/u);
  const start = app.indexOf("const previousDedupeAuditState");
  const end = app.indexOf('await rebuildPersistentEventDedupeRegistryDeterministic', start);
  const block = app.slice(start, end);
  assert.doesNotMatch(block, /purgeInvalidEventRecords/u);
});
