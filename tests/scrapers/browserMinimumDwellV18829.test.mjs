import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const tg = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
const vkChat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('event link review and reparse cannot close before a hard three-minute dwell', () => {
    assert.match(browser, /const EVENT_REVIEW_MINIMUM_OPEN_MS = 180_000/u);
    assert.match(browser, /minimumOpenMs = EVENT_REVIEW_MINIMUM_OPEN_MS/u);
    assert.match(browser, /Math\.max\([\s\S]{0,120}EVENT_REVIEW_MINIMUM_OPEN_MS/u);
    assert.match(browser, /\[EVENT LINK MINIMUM DWELL\]/u);
    const dwell = browser.indexOf("'[EVENT LINK MINIMUM DWELL]'");
    const extract = browser.indexOf('const extracted = await page.evaluate', dwell);
    assert.ok(dwell >= 0 && extract > dwell, 'minimum dwell must happen before final DOM extraction');
});

test('stored-event link reparse uses the guarded browser review path', () => {
    const start = app.indexOf('async function reparseStoredEventSourceUrl');
    const end = app.indexOf('function scoreReparsedEventForStoredRecord', start);
    const body = app.slice(start, end);
    assert.match(body, /openEventLinkForReview\(\{/u);
    assert.match(body, /keepPageOpen:\s*false/u);
});

test('public VK and Telegram finite pages enforce three minutes even if env asks for less', () => {
    assert.match(vk, /VK_PUBLIC_PAGE_HOLD_SECONDS[\s\S]{0,160}180_000,[\s\S]{0,80}300_000,[\s\S]{0,80}180_000/u);
    assert.match(tg, /TELEGRAM_HTML_PAGE_HOLD_SECONDS[\s\S]{0,160}180_000,[\s\S]{0,80}300_000,[\s\S]{0,80}180_000/u);
});

test('VK chat finite scan hold is also three minutes', () => {
    assert.match(vkChat, /const DEFAULT_POST_SCAN_HOLD_MS = 180_000/u);
});

test('manual add-event links wait 45 seconds before final DOM and cannot bypass dwell with a deadline', () => {
    const start = app.indexOf('async function parseEventProposalSubmission');
    const end = app.indexOf('\nfunction ', start + 1);
    const addFlow = app.slice(start, end > start ? end : undefined);
    assert.match(addFlow, /minimumOpenMs:\s*45_000/u);
    assert.match(addFlow, /allowShortMinimumOpen:\s*true/u);
    assert.doesNotMatch(app, /maxReviewMs:\s*30_000/u);
    assert.match(addFlow, /navigationTimeoutMs:\s*15_000/u);
    assert.match(addFlow, /manualAccessTimeoutMs:\s*5_000/u);
    assert.match(browser, /if \(!keepPageOpen && safeMinimumOpenMs > 0\)/u);
    assert.match(browser, /\[EVENT LINK REVIEW DEADLINE\]/u);
});

test('manual link parsing recovers captured DOM after the owner closes the page', () => {
    assert.match(browser, /page\.once\('close',[\s\S]{0,220}afterDomCapture:\s*Boolean\(durableDomSnapshot\?\.domCaptured\)/u);
    assert.match(browser, /if \(durableDomSnapshot\?\.domCaptured\) \{[\s\S]{0,700}browserClosedAfterDom:\s*pageWasClosed/u);
    assert.match(browser, /domCaptured:\s*Boolean\(durableDomSnapshot\?\.domCaptured\)/u);
    assert.match(browser, /captureDurableDomSnapshot\('after-ready'\)/u);
});
