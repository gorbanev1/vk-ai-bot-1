import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const tg = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');

assert.match(app, /source\.scraper\.run\(\{[\s\S]*?forceInitial:\s*true,[\s\S]*?keepPageOpen,/u);
assert.doesNotMatch(
  app.slice(app.indexOf('async function startManualScraperSource('), app.indexOf('async function pinFailedScraperSourceForOwner(')),
  /openPinnedScraperPage\(/u,
  'successful manual source must not open a second pinned review tab',
);
assert.match(vk, /\[VK SCRAPER TAB KEPT OPEN\]/u);
assert.match(vk, /keepPageOpen && completedSuccessfully/u);
assert.match(tg, /\[TG SCRAPER TAB KEPT OPEN\]/u);
assert.match(tg, /keepPageOpen && completedSuccessfully/u);
assert.match(tg, /keepPageOpen,\s*$/mu);
assert.match(tg, /reuseKey:\s*\(keepPageOpen \|\| deferClose\) \? `telegram-public:\$\{channel\}` : ''/u);
assert.match(tg, /startTelegramManualLiveParser/u);
assert.match(vk, /startVkManualLiveParser/u);

console.log('singlePassTabPersistence.test.mjs: OK');
