import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const tg = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
const vkChat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('event link review and reparse cannot close before a hard one-minute dwell', () => {
    assert.match(browser, /const EVENT_REVIEW_MINIMUM_OPEN_MS = 60_000/u);
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

test('public VK and Telegram finite pages enforce sixty seconds even if env asks for less', () => {
    assert.match(vk, /VK_PUBLIC_PAGE_HOLD_SECONDS[\s\S]{0,160}60_000,[\s\S]{0,80}120_000,[\s\S]{0,80}60_000/u);
    assert.match(tg, /TELEGRAM_HTML_PAGE_HOLD_SECONDS[\s\S]{0,160}60_000,[\s\S]{0,80}120_000,[\s\S]{0,80}60_000/u);
});

test('VK chat finite scan hold is also one minute', () => {
    assert.match(vkChat, /const DEFAULT_POST_SCAN_HOLD_MS = 60_000/u);
});
