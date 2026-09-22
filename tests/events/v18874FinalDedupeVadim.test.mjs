import assert from 'node:assert/strict';
import test from 'node:test';
import {
    EVENT_DEDUPE_ALGORITHM_VERSION,
    compareEventsDeterministic,
    deduplicateEventsTwoContour,
} from '../../src/features/events/eventDuplicateResolution.js';

test('V188.74 merges Vadim Kurylev duplicate when one card has venue name and another only address', async () => {
    const namedVenue = {
        id: 101,
        sourceType: 'vk',
        title: 'Вадим Курылёв',
        eventDate: '2026-09-19',
        eventTime: '20:00',
        venue: 'Мама Анархия',
        participants: 'Вадим Курылёв',
        sourceUrl: 'https://vk.ru/wall-1_101',
        imagePaths: ['vk_announcements/a/101-1.jpg'],
        posterImageIndex: 1,
        posterMatchStatus: 'verified_title_date_poster',
        posterVisionFacts: [{
            index: 1, poster: true, imageType: 'poster', posterConfidence: 96, textReadability: 92,
            title: 'Вадим Курылёв', dates: '19 сентября 2026', participants: 'Вадим Курылёв',
            venue: 'Мама Анархия', recognizedText: 'Вадим Курылёв · 19 сентября',
            imagePath: 'vk_announcements/a/101-1.jpg',
        }],
    };
    const addressOnly = {
        id: 102,
        sourceType: 'vk',
        title: '19.09 | Вадим Курылёв | Воронеж',
        eventDate: '2026-09-19',
        eventTime: '20:00',
        venue: 'г. Воронеж, Плехановская 48',
        participants: 'Вадим Курылёв',
        sourceUrl: 'https://vk.ru/wall-2_202',
        imagePaths: ['vk_announcements/b/202-1.jpg'],
        posterImageIndex: 1,
        posterMatchStatus: 'exact_poster_match',
        posterVisionFacts: [{
            index: 1, poster: true, imageType: 'poster', posterConfidence: 94, textReadability: 90,
            title: 'Вадим Курылёв', dates: '19 сентября 2026', participants: 'Вадим Курылёв',
            venue: 'г. Воронеж, Плехановская 48', recognizedText: 'Вадим Курылёв · 19 сентября',
            imagePath: 'vk_announcements/b/202-1.jpg',
        }],
    };

    const comparison = compareEventsDeterministic(namedVenue, addressOnly);
    assert.equal(comparison.verdict, 'same');
    assert.ok(!comparison.hardConflicts.includes('different-venue'));

    const dedupe = await deduplicateEventsTwoContour([namedVenue, addressOnly]);
    assert.equal(dedupe.events.length, 1);
    assert.equal(dedupe.events[0].eventDate, '2026-09-19');
    assert.equal(dedupe.events[0].verifiedImagePaths.length, 1);
    assert.ok([
        'vk_announcements/a/101-1.jpg',
        'vk_announcements/b/202-1.jpg',
    ].includes(dedupe.events[0].verifiedImagePaths[0]));
    assert.match(EVENT_DEDUPE_ALGORITHM_VERSION, /v18899/u);
});

test('V188.74 still keeps two genuinely different named venues apart on the same date', () => {
    const comparison = compareEventsDeterministic(
        { title: 'Вадим Курылёв', eventDate: '2026-09-19', venue: 'Мама Анархия', participants: 'Вадим Курылёв' },
        { title: 'Вадим Курылёв', eventDate: '2026-09-19', venue: 'Сто Ручьёв', participants: 'Вадим Курылёв' },
    );
    assert.equal(comparison.verdict, 'different');
    assert.ok(comparison.hardConflicts.includes('different-venue'));
});

test('V188.74 final same-day sweep runs after optimized blocking contours', async () => {
    const events = [
        { id: 1, title: 'NO PLACE FOR OLD PADS', eventDate: '2026-09-19', venue: 'Diesel Bar', participants: 'NO PLACE FOR OLD PADS' },
        { id: 2, title: 'NO PLACE FOR OLD PADS — выступление дуэта', eventDate: '2026-09-19', venue: 'Rock Bar Diesel', participants: 'NO PLACE FOR OLD PADS' },
    ];
    const result = await deduplicateEventsTwoContour(events);
    assert.equal(result.events.length, 1);
    assert.ok(Number(result.finalSweepComparedPairs) >= 0);
    assert.ok(Object.hasOwn(result, 'finalSweepMergeCount'));
});
