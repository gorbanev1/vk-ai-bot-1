import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const browser = await readFile(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
const vk = await readFile(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const tg = await readFile(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');

// Closing a manual browser is a graceful finish, never a reason to reopen it.
assert.match(app, /if \(targetClosed\) \{[\s\S]*?Автоматический повторный запуск и recovery-вкладка отключены/u);
assert.match(app, /if \(isScraperTargetClosedError\(secondError\)\)/u);
assert.match(app, /void \(async \(\) => \{[\s\S]*?startManualScraperSourceWithRecovery\(knownSource\)/u);
assert.match(app, /длинный Chromium\/AI-проход больше не блокирует/u);

// Persistent Chromium's startup blank tab is reused and orphan blank windows are closed.
assert.match(browser, /launchPersistentContext\(\) обычно сам создаёт первую about:blank/u);
assert.match(browser, /\['about:blank', 'chrome:\/\/newtab\/'\]/u);
assert.match(browser, /\[SCRAPER BROWSER IDLE CLOSE\]/u);
assert.match(browser, /onScrollStep/u);

// Public VK/TG preserve partial captures when the owner closes the tab/window.
for (const source of [vk, tg]) {
  assert.match(source, /stoppedByOwner/u);
  assert.match(source, /isScraperTargetClosedError\(error\)/u);
  assert.match(source, /manualRun:\s*keepPageOpen/u);
  assert.match(source, /allowBrowserFallback:\s*!manualRun/u);
}
assert.match(vk, /\[VK MANUAL PARSER FINISH BY CLOSE\]/u);
assert.match(tg, /\[TG MANUAL PARSER FINISH BY CLOSE\]/u);
assert.match(tg, /fallbackHtml/u);
assert.match(tg, /onScrollStep:\s*keepPageOpen/u);

console.log('manualBrowserCloseFinishV153 tests: OK');
