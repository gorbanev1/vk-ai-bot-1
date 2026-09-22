import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const tg = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
const assets = readFileSync(new URL('../../src/features/events/eventAssets.js', import.meta.url), 'utf8');

test('V151 never sends a generated event card and never repairs posters from a user-facing event command', () => {
    const start = app.indexOf('async function getEventAttachments(event, context)');
    const end = app.indexOf('async function sendPublicEventMessages', start);
    const block = app.slice(start, end);
    assert.match(block, /!isGeneratedEventCardPath\(path\)/u);
    assert.match(block, /isStrongLocalEventPosterPath\(path\)/u);
    assert.doesNotMatch(block, /recoverEventImagePathsFromVkSource|recoverVkEventPosterWithBrowser|refreshStoredEventsFromFreshSource/u);
    assert.doesNotMatch(block, /event_message_cards/u);
    assert.match(assets, /generateFallback = false/u);
});
test('V146 exact VK hydration exposes repost chain and distinguishes real wall photos from previews', () => {
    assert.match(app, /relatedWallUrls:\s*collectVkWallCopyHistorySourceUrls\(wall\)/u);
    assert.match(app, /imageConfidence:\s*vkWallHasRealPhotoAttachment\(wall\)/u);
    assert.match(app, /'preview-only'/u);
    assert.match(app, /exactVkPost\?\.imageConfidence === 'wall-photo'/u);
});

test('V146 browser poster recovery follows source -> repost original -> original community and scrolls for announcement', () => {
    assert.match(vk, /export async function recoverVkEventPosterWithBrowser/u);
    assert.match(vk, /\[VK EVENT REPOST FOLLOW\]/u);
    assert.match(vk, /await navigate\(originalUrl, 'repost original'\)/u);
    assert.match(vk, /communityUrlForOwnerId\(originalDescriptor\.ownerId\)/u);
    assert.match(vk, /await navigate\(communityUrl, 'repost community'\)/u);
    assert.match(vk, /scoreVkPosterRecoveryPost\(post, event\)/u);
    assert.match(vk, /\[VK EVENT COMMUNITY POSTER FOUND\]/u);
    assert.match(vk, /window\.scrollBy\(\{\s*top: Math\.max\(650, window\.innerHeight \* 0\.82\)/su);
});

test('V151 browser poster recovery exists only in explicit maintenance/reparse flow and is persisted there', () => {
    const start = app.indexOf('async function reparseStoredEventSourceUrl(');
    const end = app.indexOf('async function reparseAllStoredEventLinks', start);
    const block = app.slice(start, end);
    assert.match(block, /recoverVkEventPosterWithBrowser\(\{/u);
    assert.match(block, /maxSourceImages:\s*1/u);
    assert.match(block, /generateFallback:\s*false/u);
    const allStart = app.indexOf('async function reparseAllStoredEventLinks()');
    const allEnd = app.indexOf('function rankEventDeletionCandidates', allStart);
    const allBlock = app.slice(allStart, allEnd);
    assert.match(allBlock, /groups\.get\(key\)\.push\(event\)/u);
    assert.match(allBlock, /updateStoredEventRecordFromReparse\(\{/u);
    assert.match(app, /poster-browser-recovery-v(?:146|147)/u);

    const deliveryStart = app.indexOf('async function getEventAttachments(event, context)');
    const deliveryEnd = app.indexOf('async function sendPublicEventMessages', deliveryStart);
    assert.doesNotMatch(app.slice(deliveryStart, deliveryEnd), /recoverVkEventPosterWithBrowser/u);
});
test('V146 Telegram public scraper scrolls history upward, not downward', () => {
    assert.match(tg, /scrollDirection: 'up'/u);
    assert.match(browser, /safeScrollDirection/u);
    assert.match(browser, /if \(direction === 'up'\)/u);
    assert.match(browser, /telegramHistory = \/\(\?:\^\|\\\.\)t\\\.me\$\/i\.test\(location\.hostname\)/u);
    assert.match(browser, /top: -amount/u);
});
