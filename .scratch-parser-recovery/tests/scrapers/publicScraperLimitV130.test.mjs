import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSourceCountList } from '../../src/features/scrapers/sourceConfiguration.js';
import { mergeVkPublicSourceConfigurations } from '../../src/features/scrapers/publicSourcePolicy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

assert.equal(parseSourceCountList('alpha:200')[0].initialCount, 20);
assert.equal(
    mergeVkPublicSourceConfigurations([{ source: 'rb_diesel', initialCount: 200 }])
        .find((item) => item.source === 'rb_diesel')?.initialCount,
    20,
);

const vk = read('src/platforms/vk/vkPublicScraper.js');
assert.match(vk, /initialPosts\s*=\s*20/u);
assert.match(vk, /clampInteger\(initialPosts,\s*1,\s*20,\s*20\)/u);
assert.match(vk, /targetCount:\s*20,\s*\n\s*stopAtPostId:/u);
assert.doesNotMatch(vk, /targetCount:\s*200/u);

const telegram = read('src/platforms/telegram/telegramHtmlScraper.js');
assert.match(telegram, /initialMessages\s*=\s*20/u);
assert.match(telegram, /initialMessages,\s*\n\s*1,\s*\n\s*20,\s*\n\s*20,/u);

const manual = read('src/infrastructure/browser/browserGrabber.js');
assert.match(manual, /MANUAL_EVENT_AUTO_POST_LIMIT\s*=\s*20/u);
assert.doesNotMatch(manual, /posts\.length\s*>=\s*200/u);

console.log('publicScraperLimitV130.test.mjs OK');
