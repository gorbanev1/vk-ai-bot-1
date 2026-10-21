import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const browser = await readFile(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

assert.match(app, /async function reparseSingleStoredEventLink\(sourceUrl\)/u);
assert.match(app, /label: 'parser-link'/u);
assert.match(app, /reparseStoredEventSourceUrl\(canonical, records, \{ diagnostics \}\)/u);
assert.match(app, /single-reparse\.database-write/u);
assert.match(app, /single_link_v18837/u);
assert.match(app, /fallbackImages\.length === 1/u);
assert.match(app, /Гигорейв парсер ссылка <URL поста>/u);
assert.match(app, /Полный DOM, parser-report и trace/u);
assert.match(browser, /browser\.final\.raw_html/u);
assert.match(browser, /const finalHtml = await page\.content\(\)/u);

console.log('singleLinkReparseV18837 tests: OK');
