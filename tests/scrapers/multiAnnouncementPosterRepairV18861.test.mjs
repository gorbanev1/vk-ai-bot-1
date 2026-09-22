import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    fingerprintRemoteImages,
    isLikelyVkNonPosterUiImageUrl,
} from '../../src/features/events/sourcePostFingerprint.js';
import {
    parsePublicPostLocally,
} from '../../src/features/events/publicPostLocalParser.js';

test('V188.61: VK UI/avatar/audio images are rejected but a real poster survives', async () => {
    const avatar = 'https://sun9.userapi.com/x.jpg?ava=1&cs=200x200';
    const audio = 'https://sun9.userapi.com/y.jpg?type=audio';
    const tiny = 'https://sun9.userapi.com/z.jpg?cs=50x50';
    const poster = 'https://sun9.userapi.com/p.jpg?as=240x360,1080x1620&cs=50x50';
    assert.equal(isLikelyVkNonPosterUiImageUrl(avatar), true);
    assert.equal(isLikelyVkNonPosterUiImageUrl(audio), true);
    assert.equal(isLikelyVkNonPosterUiImageUrl(tiny), true);
    assert.equal(isLikelyVkNonPosterUiImageUrl(poster), false);

    const requested = [];
    const rows = await fingerprintRemoteImages({
        imageUrls: [avatar, audio, tiny, poster],
        maximum: 12,
        maxAttempts: 1,
        fetchBuffer: async (url) => {
            requested.push(url);
            return Buffer.from(`poster:${url}`);
        },
    });
    assert.deepEqual(requested, [poster]);
    assert.equal(rows.length, 1);
});

test('V188.61: Diesel labeled digest becomes ten independent events including same-day pairs', () => {
    const text = `запись закреплена
Друзья, мы составили пост-график ваших будущих планов на вечер в этом сентябре.
12.09
HALL: ASCENSION OF THE INEFFABLE GIG | 12.09 | Воронеж
BAR: DEXDBELL - Воронеж "Diesel Rock Bar"
17.09
BAR: Метал с берегов Невы, Воронеж
18.09
BAR: SPOOKERS | 18.09 Воронеж
19.09
HALL: Placebo & MCR Tribute 19.09 - Воронеж / Diesel
BAR: NO PLACE FOR OLD PADS 19.09 в Diesel Bar
25.09
BAR: SYSTEM OF A DOWN by CHOPSY Воронеж
26.09
HALL: STONEHAND (ВОРОНЕЖ) DIESEL HALL
BAR: 26 сентября | CWT | Воронеж - Презентация альбом
27.09
BAR: Ospa 1959 - Воронеж 27.09`;
    const events = parsePublicPostLocally({
        text,
        publishedAt: 1789000000,
        screenName: 'rb_diesel',
    });
    assert.equal(events.length, 10);
    assert.equal(events.filter((event) => event.eventDate === '2026-09-19').length, 2);
    assert.equal(events.filter((event) => event.eventDate === '2026-09-26').length, 2);
    assert.ok(events.every((event) => event.parseMethod === 'local_labeled_schedule_v18861'));
});

test('V188.61: parser-all refreshes DB-known posts even without a current DOM poster', async () => {
    const scraper = await readFile(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    const start = scraper.indexOf('const refreshKnownMediaCandidate');
    const body = scraper.slice(start, start + 800);
    assert.match(body, /refreshKnownMedia\s*&&\s*sourceOwnedExisting/u);
    assert.doesNotMatch(body.slice(0, 260), /hasCurrentPosterCandidate/u);
    assert.match(scraper, /VK EVENT MEDIA STORED URL FALLBACK/u);
    assert.match(scraper, /VK EVENT STORED MEDIA REPAIR/u);
    assert.match(scraper, /VK PUBLIC AI COLLAPSE REJECTED/u);
    assert.match(scraper, /parser_all_remove_vk_ui_image_v18861/u);
});

test('V188.61: stored VK source URLs are available for repair and parser AI cannot be forced below 60s', async () => {
    const db = await readFile(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const selectStart = db.indexOf('const selectVkPostMetaStatement');
    const selectBody = db.slice(selectStart, selectStart + 1600);
    assert.match(selectBody, /image_urls_json/u);
    const getterStart = db.indexOf('export function getVkPostMeta');
    assert.match(db.slice(getterStart, getterStart + 900), /imageUrlsJson/u);
    assert.match(app, /EVENT_PARSER_AI_ATTEMPT_TIMEOUT_MS[\s\S]{0,180}?60_000/u);
    assert.match(app, /filterKnownVkUiImagePathsForDisplay/u);
    assert.match(app, /EVENT VK UI POSTER REJECTED/u);
    assert.match(app, /events-v18861-multi-announcement-poster-repair/u);
});
