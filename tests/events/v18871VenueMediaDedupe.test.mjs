import assert from 'node:assert/strict';
import test from 'node:test';
import {
    EVENT_DEDUPE_ALGORITHM_VERSION,
    compareEventsDeterministic,
    eventVenueSimilarity,
    mergeDuplicateEvents,
} from '../../src/features/events/eventDuplicateResolution.js';

test('V188.71 venue type words do not affect partial venue identity', () => {
    assert.equal(eventVenueSimilarity('Бар «Крылья»', 'Клуб Крылья'), 1);
    assert.ok(eventVenueSimilarity('Diesel Hall', 'DIESEL Bar') <= 0.18);

    const left = {
        title: 'Крыльевые романы',
        eventDate: '2026-09-26',
        venue: 'Бар «Крылья»',
        sourceUrl: 'https://vk.ru/wall-1_1',
        imagePaths: ['vk_announcements/a/1-1.jpg'],
        posterImageIndex: 1,
        posterMatchStatus: 'exact_poster_match',
        posterVisionFacts: [{
            index: 1, poster: true, imageType: 'poster', posterConfidence: 99, textReadability: 98,
            title: 'Крыльевые романы', dates: '26 сентября 2026', venue: 'Бар «Крылья»',
            recognizedText: 'Крыльевые романы · 26 сентября', imagePath: 'vk_announcements/a/1-1.jpg',
        }],
    };
    const right = {
        title: 'Крыльевые романы',
        eventDate: '2026-09-26',
        venue: 'клуб Крылья, Воронеж',
        sourceUrl: 'https://vk.ru/wall-2_2',
        imagePaths: ['vk_announcements/b/2-1.jpg'],
        posterImageIndex: 1,
        posterMatchStatus: 'verified_title_date_poster',
        posterVisionFacts: [{
            index: 1, poster: true, imageType: 'poster', posterConfidence: 88, textReadability: 80,
            title: 'Крыльевые романы', dates: '26 сентября 2026', venue: 'клуб Крылья, Воронеж',
            recognizedText: 'Крыльевые романы · 26 сентября', imagePath: 'vk_announcements/b/2-1.jpg',
        }],
    };

    const comparison = compareEventsDeterministic(left, right);
    assert.equal(comparison.verdict, 'same');
    assert.ok(!comparison.hardConflicts.includes('different-venue'));

    const merged = mergeDuplicateEvents(left, right, comparison);
    // V188.86: a card renders exactly one proven real source poster. The
    // alternate verified source remains in lineage/posterCandidates only.
    assert.deepEqual(merged.verifiedImagePaths, [
        'vk_announcements/a/1-1.jpg',
    ]);
    assert.deepEqual(merged.imagePaths, [
        'vk_announcements/a/1-1.jpg',
    ]);
    assert.match(EVENT_DEDUPE_ALGORITHM_VERSION, /v18899/u);
});

test('V188.71 conflicting address numbers remain a real venue conflict', () => {
    const comparison = compareEventsDeterministic(
        { title: 'Крыльевые романы', eventDate: '2026-09-26', venue: 'Бар Крылья, Ленина 10' },
        { title: 'Крыльевые романы', eventDate: '2026-09-26', venue: 'Клуб Крылья, Ленина 22' },
    );
    assert.equal(comparison.verdict, 'different');
    assert.ok(comparison.hardConflicts.includes('different-venue'));
});


test('V188.75 DIESEL Bar and DIESEL Hall are protected distinct physical venues in RU/EN variants', () => {
    for (const bar of ['Diesel Bar', 'Rock Bar DIESEL', 'Дизель бар', 'Dizel pub']) {
        for (const hall of ['DIESEL HALL', 'Diesel Hall', 'Дизель холл', 'Дизель зал']) {
            const comparison = compareEventsDeterministic(
                { title: 'Одинаковое событие', eventDate: '2026-09-26', venue: bar },
                { title: 'Одинаковое событие', eventDate: '2026-09-26', venue: hall },
            );
            assert.equal(comparison.verdict, 'different', `${bar} vs ${hall}`);
            assert.ok(comparison.hardConflicts.includes('different-venue'), `${bar} vs ${hall}`);
        }
    }
    // For every other brand generic type words still do not participate.
    assert.equal(eventVenueSimilarity('Бар «Крылья»', 'Клуб Крылья'), 1);
});
