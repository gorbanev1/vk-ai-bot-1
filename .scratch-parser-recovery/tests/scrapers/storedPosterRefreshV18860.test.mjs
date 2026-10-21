import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    fingerprintRemoteImages,
    isLikelyVkProfileAvatarUrl,
} from '../../src/features/events/sourcePostFingerprint.js';
import {
    mergeStoredEventWithFreshSource,
    selectFreshEventForStoredEvent,
} from '../../src/features/events/eventSourceRefresh.js';

test('V188.60: VK ?ava=1 is rejected before fingerprint/download', async () => {
    const avatar = 'https://sun2-15.vkuserphoto.ru/a.jpg?quality=95&ava=1&cs=200x200';
    const poster = 'https://sun9-1.vkuserphoto.ru/poster.jpg?quality=95';
    assert.equal(isLikelyVkProfileAvatarUrl(avatar), true);
    assert.equal(isLikelyVkProfileAvatarUrl(poster), false);

    const requested = [];
    const rows = await fingerprintRemoteImages({
        imageUrls: [poster, avatar],
        maximum: 12,
        maxAttempts: 1,
        fetchBuffer: async (url) => {
            requested.push(url);
            return Buffer.from(`bytes:${url}`);
        },
    });
    assert.deepEqual(requested, [poster]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, poster);
});

test('V188.60: a fresh event poster replaces a stale stored image', () => {
    const existing = {
        id: 7,
        sourceType: 'vk',
        title: 'Майла Band',
        eventDate: '2026-09-13',
        eventTime: '19:00',
        venue: 'Бар Тупик',
        participants: 'Майла Band',
        sourceUrl: 'https://vk.ru/wall-234720249_151',
        imagePaths: ['vk_announcements/deadway36/old-avatar.jpg'],
        parseMethod: 'legacy',
    };
    const fresh = {
        title: 'Майла Band',
        eventDate: '2026-09-13',
        eventTime: '19:00',
        venue: 'Бар Тупик',
        participants: 'Майла Band',
        sourceUrl: existing.sourceUrl,
        imagePaths: ['vk_announcements/deadway36/151-1.jpg'],
        parseMethod: 'vk_html_gigachat_validated',
    };
    const merged = mergeStoredEventWithFreshSource(existing, fresh, {
        sourceUrl: existing.sourceUrl,
        parseMethod: 'parser_all_media_refresh_v18860',
    });
    assert.deepEqual(merged.imagePaths, fresh.imagePaths);
});

test('poster refresh keeps a confirmed stored poster when fresh media has no stronger evidence', () => {
    const existingPath = 'vk_announcements/demo/old.jpg';
    const existingFact = {
        index: 1, poster: true, imageType: 'poster', posterConfidence: 98, textReadability: 95,
        title: 'Alpha Night', dates: '20 сентября 2026', venue: 'Башня',
        recognizedText: 'Alpha Night 20 сентября 2026', imagePath: existingPath,
    };
    const existing = {
        title: 'Alpha Night', eventDate: '2026-09-20', venue: 'Башня', participants: 'Alpha Night',
        imagePaths: [existingPath], posterImageIndex: 1, posterMatchStatus: 'verified_single_event_source_media',
        posterVisionFacts: [existingFact],
    };
    const fresh = {
        title: existing.title, eventDate: existing.eventDate, venue: existing.venue,
        imagePaths: ['vk_announcements/demo/new.jpg'], posterImageIndex: 0, posterVisionFacts: [],
    };
    const merged = mergeStoredEventWithFreshSource(existing, fresh, { sourceUrl: 'https://vk.ru/wall-1_2' });
    assert.deepEqual(merged.imagePaths, [existingPath]);
    assert.equal(merged.posterImageIndex, 1);
    assert.equal(merged.posterMatchStatus, existing.posterMatchStatus);
});

test('poster refresh upgrades a metadata-poor stored image with a compatible fresh poster', () => {
    const freshPath = 'vk_announcements/demo/new.jpg';
    const freshFact = {
        index: 1, poster: true, imageType: 'poster', posterConfidence: 99, textReadability: 96,
        title: 'Alpha Night', dates: '20 сентября 2026', venue: 'Башня',
        recognizedText: 'Alpha Night 20 сентября 2026', imagePath: freshPath,
    };
    const existing = {
        title: 'Alpha Night', eventDate: '2026-09-20', venue: 'Башня',
        imagePaths: ['vk_announcements/demo/legacy.jpg'], posterImageIndex: 1,
        posterMatchStatus: 'metadata_pending_existing_poster', posterVisionFacts: [],
    };
    const fresh = {
        title: existing.title, eventDate: existing.eventDate, venue: existing.venue, participants: 'Alpha Night',
        imagePaths: [freshPath], posterImageIndex: 1, posterMatchStatus: 'verified_single_event_source_media',
        posterVisionFacts: [freshFact],
    };
    const merged = mergeStoredEventWithFreshSource(existing, fresh, { sourceUrl: 'https://vk.ru/wall-1_2' });
    assert.deepEqual(merged.imagePaths, [freshPath]);
    assert.equal(merged.posterImageIndex, 1);
    assert.equal(merged.posterMatchStatus, fresh.posterMatchStatus);
});

test('V188.60: partial refresh matches only the correct event from a digest', () => {
    const stored = {
        title: 'SYSTEM OF A DOWN by CHOPSY',
        eventDate: '2026-09-25',
        eventTime: null,
        venue: 'Diesel Bar',
    };
    const fresh = [
        {
            title: 'SPOOKERS',
            eventDate: '2026-09-18',
            venue: 'Diesel Bar',
            imagePaths: ['18.jpg'],
        },
        {
            title: 'SYSTEM OF A DOWN by CHOPSY',
            eventDate: '2026-09-25',
            venue: 'Diesel Bar',
            imagePaths: ['25.jpg'],
        },
    ];
    const selected = selectFreshEventForStoredEvent(stored, fresh);
    assert.equal(selected?.eventDate, '2026-09-25');
    assert.deepEqual(selected?.imagePaths, ['25.jpg']);
});

test('V188.60: parser-all rechecks known media and protects unmatched stored rows', async () => {
    const scraper = await readFile(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(app, /refreshKnownMedia:\s*true/u);
    assert.match(scraper, /refreshKnownMediaCandidate/u);
    assert.match(scraper, /forceKnownMediaRefresh/u);
    assert.match(scraper, /protectPartialKnownRefresh/u);
    assert.match(scraper, /merge-partial-media-refresh/u);
    assert.match(scraper, /databaseRefreshCount/u);
    assert.match(app, /selectedImages\.confidence === 'preview-only'[\s\S]*?imageUrls/u);
    assert.match(app, /estimatePublicAnnouncementMultiplicity/u);
    assert.match(app, /text-extraction\.completeness-retry/u);
    assert.match(app, /event-parser:public-text-completeness-retry/u);
    assert.match(app, /events-v18860-parser-all-poster-refresh/u);
});
