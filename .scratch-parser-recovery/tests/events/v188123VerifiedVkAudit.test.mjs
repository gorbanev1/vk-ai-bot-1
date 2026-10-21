import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
    imageFingerprintSetsEqual, imageFingerprintSetsReusable,
    fingerprintImageUrlFallback,
} from '../../src/features/events/sourcePostFingerprint.js';
import { dedupeAllPartiesRealtime, findAllPartySharedTitleWord } from '../../src/features/events/allPartyDedupe.js';
import { runManualParserPool } from '../../src/features/scrapers/manualProcessingPool.js';
import { canonicalVkWallUrl } from '../../src/features/events/eventProvenance.js';
import { findAnnouncementDateSignals } from '../../src/features/events/eventMultiAnnouncementBlocks.js';
import { assignEventImageIndexesFromFacts } from '../../src/features/events/eventPosterMatching.js';

const event = (id, partyPool, title, sourceType = 'vk') => ({
    id, partyPool, title, sourceType, eventDate: '2026-09-26', venue: 'Клуб',
});

test('Astra poster-date P0 is a false positive: original ISO day/month conversion binds real posters', () => {
    const [assigned] = assignEventImageIndexesFromFacts(
        [{ title: 'STONEHAND', eventDate: '2026-09-26', venue: 'Diesel Hall' }],
        '[IMAGE 1]\nЭто афиша события: да\nНазвание: STONEHAND\nДата: 26 сентября 2026\nМесто: Diesel Hall',
    );
    assert.equal(assigned.posterImageIndex, 1);
    assert.notEqual(assigned.posterMatchStatus, 'no_safe_poster');
});

test('degraded CDN fingerprints must never suppress a retry/vision, even when URLs match', () => {
    const fallback = fingerprintImageUrlFallback('https://cdn.example/image.jpg');
    const actual = { visualHash: 'real-image-payload-hash' };
    assert.equal(imageFingerprintSetsReusable([fallback], [fallback]), false);
    assert.equal(imageFingerprintSetsEqual([fallback], [fallback]), false);
    assert.equal(imageFingerprintSetsReusable([actual, fallback], [actual, fallback]), false);
    assert.equal(imageFingerprintSetsEqual([actual, fallback], [actual, fallback]), false);
    assert.equal(imageFingerprintSetsReusable([actual], [actual]), true);
    assert.equal(imageFingerprintSetsEqual([actual], [actual]), true);
});

test('primary and secondary cannot be merged by a shared title', () => {
    const primary = event(1, 'primary', 'STONEHAND концерт');
    const secondary = event(2, 'secondary', 'STONEHAND встреча');
    assert.equal(findAllPartySharedTitleWord(primary, secondary), '');
    assert.equal(dedupeAllPartiesRealtime([primary, secondary]).events.length, 2);
});

test('QTickets still dedupes against primary but cannot bridge primary to secondary', () => {
    const primary = event(1, 'primary', 'STONEHAND концерт');
    const aggregator = event(2, 'qtickets', 'STONEHAND шоу', 'qtickets');
    const secondary = event(3, 'secondary', 'STONEHAND вечер');
    const output = dedupeAllPartiesRealtime([primary, aggregator, secondary]);
    assert.equal(output.events.length, 2);
    assert.equal(output.events.filter((item) => item.sourceType === 'qtickets').length, 1);
});

test('transitive title chains must not union incompatible event identities', () => {
    const a = event(1, 'primary', 'STONEHAND BLACKBIRD');
    const b = event(2, 'primary', 'BLACKBIRD NIGHTFALL');
    const c = event(3, 'primary', 'NIGHTFALL RADIANT');
    assert.equal(dedupeAllPartiesRealtime([a, b, c]).events.length, 2);
});

test('failed diagnostic callbacks cannot mark a successful item failed or repeat worker', async () => {
    let calls = 0;
    const warn = console.warn;
    console.warn = () => {};
    try {
        const result = await runManualParserPool([1, 2], async (item) => {
            calls += 1;
            return item * 2;
        }, { concurrency: 2, onItemState: async () => { throw new Error('telemetry down'); } });
        assert.deepEqual(result.map((item) => item.status), ['fulfilled', 'fulfilled']);
        assert.deepEqual(result.map((item) => item.value), [2, 4]);
        assert.equal(calls, 2);
    } finally { console.warn = warn; }
});

test('canonical VK wall requires a VK host and precise wall path or w parameter', () => {
    assert.equal(canonicalVkWallUrl('https://vk.ru/wall-15_26'), 'https://vk.ru/wall-15_26');
    assert.equal(canonicalVkWallUrl('https://m.vk.com/?w=wall-15_26'), 'https://vk.ru/wall-15_26');
    assert.equal(canonicalVkWallUrl('https://example.org/wall-15_26'), '');
    assert.equal(canonicalVkWallUrl('https://vk.ru/im?sel=wall-15_26'), '');
});

test('numeric dates validate day/month and explicit leap years', () => {
    const found = findAnnouncementDateSignals('31.02.2026 31.04 29.02.2025 29.02.2024 30.04');
    assert.deepEqual(found.map((item) => item.raw), ['29.02.2024', '30.04']);
    assert.equal(findAnnouncementDateSignals('29.02').length, 1);
});

test('VK public contour report no longer pretends live rendered DOM is immutable snapshot', () => {
    const code = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    assert.match(code, /sameSnapshotForAllThreeContours: false,/u);
    assert.match(code, /mediaRefreshFromLiveDom: true,/u);
    assert.match(code, /split\('\+'\)\.includes\('pass2-adaptive'\)/u);
});

test('blank AI displayDate does not erase a human-readable date already present', async () => {
    const { mergeNormalizedEvent } = await import('../../src/features/events/eventAnnouncementNormalization.js');
    const original = {
        title: 'STONEHAND', displayDate: '26 сентября 2026', eventDate: '2026-09-26',
        description: 'STONEHAND 26 сентября 2026 в Diesel Hall.',
    };
    assert.equal(mergeNormalizedEvent(original, { displayDate: '' }).displayDate, '26 сентября 2026');
    assert.equal(mergeNormalizedEvent(original, { displayDate: '26.09.2026' }).displayDate, '26.09.2026');
});

test('unknown or broken image fingerprint must not be treated as a successful CDN fetch', () => {
    const concrete = { sha256: 'actual-image-hash' };
    assert.equal(imageFingerprintSetsReusable([concrete], [null]), false);
    assert.equal(imageFingerprintSetsEqual([concrete, null], [concrete, null]), false);
    assert.equal(imageFingerprintSetsReusable([concrete], [concrete]), true);
});

test('VK canonicalizer rejects embedded fake VK URL and preserves native query-form post', () => {
    assert.equal(canonicalVkWallUrl('https://vk.ru.evil.example/wall-15_26'), '');
    assert.equal(canonicalVkWallUrl('https://vk.ru/feed?w=wall-15_26'), 'https://vk.ru/wall-15_26');
    assert.equal(canonicalVkWallUrl('https://vk.ru/wall-15_26?from=feed'), 'https://vk.ru/wall-15_26');
});
