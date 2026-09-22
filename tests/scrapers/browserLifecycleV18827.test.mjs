import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const tg = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');

test('finite public source tabs dwell for at least three minutes so lazy media can settle', () => {
    assert.match(vk, /VK_PUBLIC_PAGE_HOLD_SECONDS[\s\S]{0,160}180_000,[\s\S]{0,80}300_000,[\s\S]{0,80}180_000/u);
    assert.match(tg, /TELEGRAM_HTML_PAGE_HOLD_SECONDS[\s\S]{0,160}180_000,[\s\S]{0,80}300_000,[\s\S]{0,80}180_000/u);
});

test('finite public tabs close only after the source processing promise finishes', () => {
    assert.match(vk, /let finiteSourcePage = null/u);
    assert.match(vk, /deferClose:\s*!keepPageOpen/u);
    assert.match(vk, /finally \{[\s\S]{0,500}!keepPageOpen && finiteSourcePage[\s\S]{0,250}SOURCE TAB CLOSED AFTER PROCESSING/u);
    assert.match(tg, /let finiteSourcePage = null/u);
    assert.match(tg, /deferClose:\s*!keepPageOpen/u);
    assert.match(tg, /finally \{[\s\S]{0,500}!keepPageOpen && finiteSourcePage[\s\S]{0,250}SOURCE TAB CLOSED AFTER PROCESSING/u);
});

test('browser activity lease prevents context churn while post/media processing is still active', () => {
    assert.match(browser, /export function acquireScraperBrowserActivityLease/u);
    assert.match(browser, /browserActivityLeases > 0 \|\| managedPages\.size > 0/u);
    assert.match(browser, /ORPHAN_BROWSER_IDLE_CLOSE_MS[\s\S]{0,180}10 \* 60_000/u);
    assert.match(app, /acquireScraperBrowserActivityLease\(\{[\s\S]{0,180}manual-source:/u);
    assert.match(app, /releaseBrowserLease\(\)/u);
});

test('only a real external persistent-context close advances owner-stop generation', () => {
    const attachStart = browser.indexOf('function attachManagedPage');
    const attachEnd = browser.indexOf('function readBoolean', attachStart);
    const attach = browser.slice(attachStart, attachEnd);
    assert.doesNotMatch(attach, /browserCloseGeneration \+= 1/u);
    assert.match(browser, /const intentional = intentionalContextCloses\.has\(context\)/u);
    assert.match(browser, /if \(!intentional\) \{[\s\S]{0,180}browserCloseGeneration \+= 1/u);
});

test('startup about:blank is reusable for finite sources too', () => {
    assert.match(browser, /Всегда забираем уже существующую пустую стартовую вкладку/u);
    assert.match(browser, /\['about:blank', 'chrome:\/\/newtab\/'\]/u);
});
