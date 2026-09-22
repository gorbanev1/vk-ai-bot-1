import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('V131 hydrates VK posters from rendered DOM and VK API without exceeding 20 posts', () => {
    const scraper = read('src/platforms/vk/vkPublicScraper.js');
    const app = read('src/app/botApplication.js');

    assert.match(scraper, /Math\.min\(20,\s*Math\.trunc\(Number\(targetCount\)/u);
    assert.match(scraper, /getComputedStyle\(node\)\.backgroundImage/u);
    assert.match(scraper, /data-srcset/u);
    assert.match(scraper, /picture source\[srcset\]/u);
    assert.match(scraper, /hydratePostsWithApi/u);
    assert.match(scraper, /\[VK EVENT MEDIA RETRY\]/u);
    assert.match(scraper, /onlyGeneratedFallbacks/u);
    assert.match(scraper, /existsSync\(join\(dataDirectory, path\)\)/u);

    assert.match(app, /async function hydrateVkPublicPostsWithApiMedia\(posts\)/u);
    assert.match(app, /wall\.getById\(\{\s*posts:\s*postKeys\.join\(','\)/su);
    assert.match(app, /hydratePostsWithApi:\s*hydrateVkPublicPostsWithApiMedia/u);
    assert.match(app, /posts\.slice\(0, 20\)/u);
});
