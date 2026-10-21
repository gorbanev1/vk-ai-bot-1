import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    deduplicateEventsTwoContour,
    EVENT_DEDUPE_ALGORITHM_VERSION,
} from '../../src/features/events/eventDuplicateResolution.js';
import {
    mergeStoredEventWithFreshSource,
    selectFreshEventForStoredEvent,
} from '../../src/features/events/eventSourceRefresh.js';

test('V147 merges cosmetic duplicate party cards even when participant spellings differ', async () => {
    const a = {
        sourceType: 'vk',
        sourceName: 'afalina',
        sourceUrl: 'https://vk.ru/wall-100_1',
        title: 'Afalinamusic: for Friends',
        eventDate: '2026-09-04',
        eventTime: '22:00',
        timeLabel: '22:00–00:30 Botsan; 00:30–04:00 Siluyanov',
        venue: 'Караоке-клуб СОВА, первый зал',
        participants: 'Botsan, Siluyanov',
        description: 'Два последовательных сета. Вход свободный.',
    };
    const b = {
        sourceType: 'telegram',
        sourceName: '@afalina',
        sourceUrl: 'https://t.me/afalina/50',
        title: 'AfalinaMusic: for Friends',
        eventDate: '2026-09-04',
        eventTime: '22:00',
        timeLabel: '22:00–00:30 Botsan; 00:30–04:00 Siluyanov',
        venue: 'клуб «СОВА», первый зал',
        participants: 'Роман Боцан, Alexandr Siluyanov',
        description: 'Музыкальная встреча с двумя сетами. Вход свободный.',
    };

    const result = await deduplicateEventsTwoContour([a, b]);
    assert.equal(result.events.length, 1);
    assert.match(EVENT_DEDUPE_ALGORITHM_VERSION, /v(?:147|149|151|154)/u);
});

test('V147 one fresh child from a digest cannot overwrite unrelated stored children', () => {
    const fresh = {
        title: 'Red Fox Tails',
        eventDate: '2026-09-11',
        eventTime: '21:00',
        venue: 'Liverpool Pub, Воронеж',
    };

    assert.equal(
        selectFreshEventForStoredEvent({
            title: 'Red Fox Tails',
            eventDate: '2026-09-11',
            eventTime: '21:00',
            venue: 'Liverpool Pub, Воронеж',
        }, [fresh]),
        fresh,
    );

    assert.equal(
        selectFreshEventForStoredEvent({
            title: 'Алексей Вдовин',
            eventDate: '2026-09-19',
            eventTime: '20:00',
            venue: 'Liverpool Pub, Воронеж',
        }, [fresh]),
        null,
    );
});

test('V147 verified event poster replaces stale inherited parent poster', () => {
    const merged = mergeStoredEventWithFreshSource({
        title: 'Red Fox Tails',
        eventDate: '2026-09-11',
        venue: 'Liverpool Pub',
        imagePaths: ['vk_announcements/liverpool/monthly-schedule.jpg'],
    }, {
        title: 'Red Fox Tails',
        eventDate: '2026-09-11',
        venue: 'Liverpool Pub',
        imagePaths: ['event_message_source_recovery/red-fox-specific.jpg'],
    }, {
        sourceUrl: 'https://vk.ru/wall-95062430_2711',
    });

    assert.deepEqual(merged.imagePaths, [
        'event_message_source_recovery/red-fox-specific.jpg',
    ]);
    assert.equal(merged.sourceUrl, 'https://vk.ru/wall-95062430_2711');
});

test('V147 parser no longer assigns one post image to every child event', () => {
    const source = readFileSync(
        new URL('../../src/features/events/eventAssets.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /sourceHasMultipleEvents/u);
    assert.match(source, /mayInheritSourceImages/u);
    assert.match(source, /_sourceImagePaths:\s*downloaded/u);
    assert.doesNotMatch(source, /let eventImagePaths = downloaded;/u);
});

test('V147 specific VK poster recovery excludes parent digest/original posts', () => {
    const source = readFileSync(
        new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /requireSpecificAnnouncement = false/u);
    assert.match(source, /excludedPostKeys/u);
    assert.match(source, /!excludedPostKeys\.has/u);
});

test('V147 SQLite migration clears inherited shared media and normal reads honor dedupe registry', () => {
    const source = readFileSync(
        new URL('../../src/infrastructure/database/index.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /public-events-v147-event-level-media-persistent-dedupe/u);
    assert.match(source, /vkSharedMediaCleared/u);
    assert.match(source, /telegramSharedMediaCleared/u);
    assert.match(source, /dm\.scope = 'configured'/u);
    assert.match(source, /dm\.role = 'duplicate'/u);
});


test('V147 display rejects an existing JPEG when it belongs to a digest parent', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /EVENT STALE DIGEST POSTER REJECTED/u);
    assert.match(source, /storedPosterBelongsToDigest \? \[\] : existingStrongImagePaths/u);
    assert.match(source, /poster_recovery_v147\|poster-browser-recovery-v147/u);
});

test('V147 verified snapshot rebuild reads raw SQLite rows and cannot erase its own dedupe registry', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );
    const start = source.indexOf('function getRawUpcomingEventsForModeration');
    const end = source.indexOf('function normalizeEventDedupeRef', start);
    assert.ok(start >= 0 && end > start);
    const block = source.slice(start, end);
    assert.match(block, /getAllUpcomingEventRecordsForDedupe/u);
    assert.doesNotMatch(block, /flatMap\(\(scraper\)\s*=>\s*scraper\.getUpcoming/u);
});
