import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { fingerprintRemoteImages } from '../../src/features/events/sourcePostFingerprint.js';

test('V188.59: all ten posters of one digest post survive pre-AI fingerprinting', async () => {
    const urls = Array.from({ length: 10 }, (_, index) => `https://sun9-1.userapi.com/poster-${index + 1}.jpg`);
    const requested = [];
    const result = await fingerprintRemoteImages({
        imageUrls: urls,
        maximum: 12,
        maxAttempts: 1,
        fetchBuffer: async (url) => {
            requested.push(url);
            return Buffer.from(`poster-bytes:${url}`);
        },
    });
    assert.equal(requested.length, 10);
    assert.deepEqual(requested, urls);
    assert.equal(result.length, 10);
    assert.deepEqual(result.map((item) => item.url), urls);
});

test('V188.59: explicit event-to-poster mapping wins and Russian month-name matching exists', async () => {
    const source = await readFile(new URL('../../src/features/events/eventAssets.js', import.meta.url), 'utf8');
    const start = source.indexOf('export function assignEventImageIndexesFromFacts');
    const end = source.indexOf('\n/**', start + 20);
    const body = source.slice(start, end > start ? end : start + 12_000);
    const explicitIndex = body.indexOf('if (explicit.length)');
    const heuristicIndex = body.indexOf('let best = null');
    assert.ok(explicitIndex >= 0 && heuristicIndex > explicitIndex);
    assert.match(body, /сентября/u);
    assert.match(body, /monthNames/u);
    assert.match(body, /monthShort/u);
});

test('V188.59: VK logged-in profile avatar is rejected from poster candidates', async () => {
    const source = await readFile(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    const matches = source.match(/ava=1/g) ?? [];
    assert.ok(matches.length >= 2, 'both legacy and exact DOM image admission must reject ?ava=1');
});

test('V188.59: poster vision reports batch completeness and public extraction has multi-event output budget', async () => {
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const factsStart = app.indexOf('async function readManualEventImageFacts');
    const factsEnd = app.indexOf('\nasync function ', factsStart + 20);
    const facts = app.slice(factsStart, factsEnd > factsStart ? factsEnd : factsStart + 20_000);
    assert.match(facts, /batch_start/u);
    assert.match(facts, /batch_complete/u);
    assert.match(facts, /completedImageNumbers/u);
    assert.match(facts, /failedImageNumbers/u);
    const publicStart = app.indexOf('async function extractPublicEventsWithGpt');
    const publicEnd = app.indexOf('\nfunction ', publicStart + 20);
    const publicBody = app.slice(publicStart, publicEnd > publicStart ? publicEnd : publicStart + 20_000);
    assert.match(publicBody, /maxTokens:\s*6000/u);
    assert.match(publicBody, /не ограничивай ответ первым событием/u);
    assert.match(app, /events-v188(?:59-multi-announcement-media|60-parser-all-poster-refresh)/u);
});
