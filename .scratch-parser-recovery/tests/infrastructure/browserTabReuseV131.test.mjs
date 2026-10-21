import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('V131 reuses owner-visible scraper tabs instead of opening the same page repeatedly', () => {
    const browser = read('src/infrastructure/browser/browserGrabber.js');
    const vk = read('src/platforms/vk/vkPublicScraper.js');
    const telegram = read('src/platforms/telegram/telegramHtmlScraper.js');

    assert.match(browser, /const reusablePages = new Map\(\)/u);
    assert.match(browser, /reuseKey = ''/u);
    assert.match(browser, /reusablePages\.get\(normalizedReuseKey\)/u);
    assert.match(browser, /reuseKey:\s*keepPageOpen \? `manual-event:\$\{url\}` : ''/u);
    assert.match(browser, /reuseKey:\s*`pinned:\$\{source\}:\$\{url\}`/u);
    assert.match(vk, /reuseKey:\s*keepPageOpen \? `vk-public:\$\{screenName\}` : ''/u);
    assert.match(telegram, /reuseKey:\s*\(keepPageOpen \|\| deferClose\) \? `telegram-public:\$\{channel\}` : ''/u);
});

test('manual source tabs stay single-instance and keep parsing newly loaded posts during manual scroll', () => {
    const browser = read('src/infrastructure/browser/browserGrabber.js');
    const vk = read('src/platforms/vk/vkPublicScraper.js');
    const telegram = read('src/platforms/telegram/telegramHtmlScraper.js');
    assert.match(browser, /MANUAL_EVENT_AUTO_POST_LIMIT = 20/u);
    assert.match(browser, /remaining=manual-scroll/u);
    assert.match(telegram, /startTelegramManualLiveParser/u);
    assert.match(telegram, /TG MANUAL SCROLL LIVE PARSER/u);
    assert.match(telegram, /await page\.content\(\)/u);
    assert.match(vk, /startVkManualLiveParser/u);
    assert.match(vk, /VK MANUAL SCROLL LIVE PARSER/u);
    assert.match(vk, /extractRenderedVkPosts/u);
});
