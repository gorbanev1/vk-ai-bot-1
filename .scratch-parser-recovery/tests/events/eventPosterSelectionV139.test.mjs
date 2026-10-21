import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    detectRasterImageDimensions,
    rankEventImageCandidates,
    scoreEventImageCandidate,
} from '../../src/features/events/eventImageSelection.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('V139 prefers a real large event photo over UI/icon candidates', () => {
    const ranked = rankEventImageCandidates([
        { url: 'https://cdn.example/icon.jpg', width: 96, height: 96, mediaHint: 'dom-generic' },
        { url: 'https://cdn.example/poster.jpg', width: 1080, height: 1350, mediaHint: 'direct-photo' },
        { url: 'https://cdn.example/logo.jpg', width: 256, height: 256, mediaHint: 'dom-media' },
    ]);

    assert.equal(ranked[0].url, 'https://cdn.example/poster.jpg');
    assert.ok(
        scoreEventImageCandidate({ width: 1080, height: 1350, mediaHint: 'local-source' }) >
        scoreEventImageCandidate({ width: 96, height: 96, mediaHint: 'local-source' }),
    );
});

test('V139 can inspect PNG dimensions before choosing a local poster', () => {
    const png = Buffer.alloc(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    png.writeUInt32BE(1200, 16);
    png.writeUInt32BE(1500, 20);
    assert.deepEqual(detectRasterImageDimensions(png), { width: 1200, height: 1500 });
});

test('V151 VK media pipeline uses API media as authority while user event delivery is strictly local-only', () => {
    const app = read('src/app/botApplication.js');
    const scraper = read('src/platforms/vk/vkPublicScraper.js');

    assert.match(app, /imageUrls:\s*\(apiImageUrls\.length \? apiImageUrls : domImageUrls\)\.slice\(0, 4\)/u);
    const start = app.indexOf('async function getEventAttachments(event, context)');
    const end = app.indexOf('async function sendPublicEventMessages', start);
    const block = app.slice(start, end);
    assert.match(block, /isStrongLocalEventPosterPath\(path\)/u);
    assert.match(block, /V151: пользовательская выдача строго local-only/u);
    assert.doesNotMatch(block, /recoverVkEventPosterWithBrowser|recoverEventImagePathsFromVkSource|refreshStoredEventsFromFreshSource/u);
    assert.match(block, /return attachments\[0\] \?\? null;/u);

    assert.match(scraper, /vk-playwright-v\d+-[a-z0-9-]+/u);
    assert.doesNotMatch(scraper, /<\(\?:img\|source\|a\|div\)\\b/u);
    assert.match(scraper, /avatar\|profile\|emoji\|reaction\|sticker\|icon\|badge\|logo/u);
    assert.match(scraper, /Background-image читаем только у узлов/u);
});
