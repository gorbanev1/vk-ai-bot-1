import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const vkPublic = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const telegram = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

assert.match(app, /SCRAPER_ALL_LAUNCH_STAGGER_MS/u);
assert.match(app, /Promise\.all\(sources\.map\(async \(source, index\)/u);
assert.match(app, /launchStaggerMs \* index/u);
assert.doesNotMatch(app, /Запускаем последовательно: публичные браузерные парсеры/u);

assert.match(vkPublic, /window\.scrollBy\(\{/u);
assert.match(vkPublic, /behavior: 'smooth'/u);
assert.match(vkPublic, /VK_PUBLIC_SCROLL_DELAY_MS/u);
assert.doesNotMatch(vkPublic, /window\.scrollTo\(0, document\.body\.scrollHeight\)/u);

assert.match(telegram, /TELEGRAM_HTML_RENDER_SCROLL_DELAY_MS/u);
assert.match(telegram, /900/u);
assert.match(browser, /window\.innerHeight \* 0\.72/u);
assert.match(browser, /behavior: 'smooth'/u);

console.log('V113 parallel manual scraper launch + slow scrolling tests: OK');
