import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compareEventsDeterministic,
    deduplicateEventsTwoContour,
    mergeDuplicateEvents,
    selectBestPosterCandidateForEvent,
} from '../../src/features/events/eventDuplicateResolution.js';
import {
    evaluatePosterFactForEvent,
    scorePosterFactMetadataQuality,
} from '../../src/features/events/eventPosterMatching.js';
import {
    eventHasSafePosterMatch,
    getEventPosterSafetyAssessment,
} from '../../src/features/events/eventProvenance.js';
import { dedupeAllPartiesRealtime } from '../../src/features/events/allPartyDedupe.js';

function posterFact({
    index = 1,
    title,
    dates = '20 сентября 2026',
    participants = '',
    venue = 'Башня',
    confidence = 98,
    readability = 95,
    path = '',
    hash = '',
} = {}) {
    return {
        index,
        poster: true,
        imageType: 'poster',
        posterConfidence: confidence,
        textReadability: readability,
        title,
        dates,
        participants,
        venue,
        recognizedText: `${title || ''} ${dates} ${participants}`.trim(),
        imagePath: path,
        imageSha256: hash,
    };
}

function eventWithPoster({
    id,
    title,
    venue = 'Башня',
    participants = '',
    path,
    fact,
    status = 'exact_poster_match',
    sourceType = 'vk',
} = {}) {
    return {
        id,
        sourceType,
        title,
        eventDate: '2026-09-20',
        eventTime: '18:00',
        venue,
        participants,
        imagePaths: path ? [path] : [],
        verifiedImagePaths: path ? [path] : [],
        posterImageIndex: fact?.index || 1,
        posterMatchStatus: status,
        posterMatchReason: 'fixture',
        posterVisionFacts: fact ? [fact] : [],
        _dedupeRefs: id ? [{ sourceType, id }] : [],
    };
}

test('V188.99 date-only poster is not renderable without event identity', () => {
    const fact = posterFact({ title: 'Совсем другая вечеринка' });
    const event = eventWithPoster({
        id: 1,
        title: 'Праздник урожая',
        participants: 'Пахари Моря',
        path: 'vk_announcements/harvest/wrong.jpg',
        fact,
    });

    const direct = evaluatePosterFactForEvent(event, fact);
    assert.equal(direct.accepted, false);
    assert.equal(direct.reason, 'date-without-event-identity');
    assert.equal(eventHasSafePosterMatch(event), false);
});


test('V188.99 selected metadata must bind the exact rendered file path', () => {
    const fact = posterFact({ title: 'Праздник урожая', path: 'posters/right.jpg' });
    const mismatched = eventWithPoster({
        id: 2,
        title: 'Праздник урожая',
        path: 'posters/wrong.jpg',
        fact,
    });
    const assessment = getEventPosterSafetyAssessment(mismatched);
    assert.equal(assessment.accepted, false);
    assert.equal(assessment.reason, 'selected-poster-path-mismatch');

    const missingPathFact = { ...fact, imagePath: '' };
    const missingPath = eventWithPoster({
        id: 3,
        title: 'Праздник урожая',
        path: 'posters/right.jpg',
        fact: missingPathFact,
    });
    const missingAssessment = getEventPosterSafetyAssessment(missingPath);
    assert.equal(missingAssessment.accepted, false);
    assert.equal(missingAssessment.reason, 'missing-selected-poster-path-metadata');
});

test('V188.99 historical safe status without selected Vision metadata is text-only', () => {
    const event = {
        title: 'Праздник урожая',
        eventDate: '2026-09-20',
        imagePaths: ['vk_announcements/harvest/legacy.jpg'],
        posterImageIndex: 1,
        posterMatchStatus: 'exact_poster_match',
        posterVisionFacts: [],
    };
    const assessment = getEventPosterSafetyAssessment(event);
    assert.equal(assessment.accepted, false);
    assert.equal(assessment.reason, 'missing-selected-poster-metadata');
});

test('V188.99 dedupe collapses metadata-poor obsolete card and keeps canonical relevant poster', async () => {
    const goodPath = 'vk_announcements/harvest/good.jpg';
    const goodFact = posterFact({
        title: 'Праздник урожая',
        participants: 'Пахари Моря',
        venue: 'Башня, Винзавод',
        path: goodPath,
        hash: 'a'.repeat(64),
    });
    const good = eventWithPoster({
        id: 11,
        title: 'Праздник урожая — концерт',
        venue: 'Башня, Винзавод',
        participants: 'Пахари Моря',
        path: goodPath,
        fact: goodFact,
    });

    const stalePath = 'telegram_announcements/harvest/stale.jpg';
    const staleFact = posterFact({
        title: 'Другая вечеринка',
        participants: 'Другой артист',
        venue: 'Старый клуб',
        path: stalePath,
        hash: 'b'.repeat(64),
        confidence: 75,
        readability: 60,
    });
    const stale = eventWithPoster({
        id: 12,
        sourceType: 'telegram',
        title: 'Праздник урожая',
        venue: 'Старый клуб',
        participants: 'Пахари Моря',
        path: stalePath,
        fact: staleFact,
    });

    assert.equal(eventHasSafePosterMatch(good), true);
    assert.equal(eventHasSafePosterMatch(stale), false);
    const comparison = compareEventsDeterministic(good, stale);
    assert.equal(comparison.verdict, 'same');
    assert.ok(comparison.reasons.includes('v18899-metadata-superseded-card'));

    const dedupe = await deduplicateEventsTwoContour([stale, good]);
    assert.equal(dedupe.events.length, 1);
    const [canonical] = dedupe.events;
    assert.deepEqual(canonical.imagePaths, [goodPath]);
    assert.deepEqual(canonical.verifiedImagePaths, [goodPath]);
    assert.equal(canonical.venue, 'Башня, Винзавод');
    assert.equal(eventHasSafePosterMatch(canonical), true);
    assert.match(canonical.posterMatchReason, /^dedupe-best-metadata:/u);
});

test('V188.99 among two relevant posters merge chooses stronger relevance then richer metadata, not source order', () => {
    const event = {
        title: 'STONEHAND',
        eventDate: '2026-09-20',
        participants: 'STONEHAND',
        venue: 'DIESEL HALL',
    };
    const weakerFact = posterFact({
        title: 'STONEHAND',
        participants: '',
        venue: 'DIESEL HALL',
        path: 'a.jpg',
        confidence: 70,
        readability: 60,
    });
    const richerFact = posterFact({
        title: 'STONEHAND',
        participants: 'STONEHAND',
        venue: 'DIESEL HALL',
        path: 'b.jpg',
        confidence: 99,
        readability: 99,
        hash: 'c'.repeat(64),
    });
    const candidates = [
        { path: 'a.jpg', posterImageIndex: 1, posterFact: weakerFact, posterVisionFacts: [weakerFact] },
        { path: 'b.jpg', posterImageIndex: 1, posterFact: richerFact, posterVisionFacts: [richerFact] },
    ];
    assert.ok(scorePosterFactMetadataQuality(richerFact) > scorePosterFactMetadataQuality(weakerFact));
    const selected = selectBestPosterCandidateForEvent(event, candidates);
    assert.equal(selected?.candidate?.path, 'b.jpg');
});

test('V188.99 merged verifiedImagePaths never bypass metadata validation', () => {
    const goodFact = posterFact({ title: 'Alpha', path: 'good.jpg' });
    const left = eventWithPoster({ id: 21, title: 'Alpha', path: 'good.jpg', fact: goodFact });
    const right = {
        id: 22,
        sourceType: 'telegram',
        title: 'Alpha',
        eventDate: '2026-09-20',
        venue: 'Башня',
        imagePaths: ['bad.jpg'],
        verifiedImagePaths: ['bad.jpg'],
        posterImageIndex: 1,
        posterMatchStatus: 'exact_poster_match',
        posterVisionFacts: [],
        _dedupeRefs: [{ sourceType: 'telegram', id: 22 }],
    };
    const merged = mergeDuplicateEvents(right, left, { contour: 'v18899-test' });
    assert.deepEqual(merged.imagePaths, ['good.jpg']);
    assert.equal(eventHasSafePosterMatch(merged), true);
});


test('V188.99 all-party QTickets winner borrows only the best strictly matching metadata-backed poster', () => {
    const goodFact = posterFact({
        title: 'STONEHAND',
        participants: 'STONEHAND',
        venue: 'DIESEL HALL',
        path: 'vk_announcements/stonehand/good.jpg',
        hash: 'd'.repeat(64),
    });
    const badFact = posterFact({
        title: 'Совсем другой концерт',
        participants: 'Другой артист',
        venue: 'Другой клуб',
        path: 'telegram_announcements/stonehand/bad.jpg',
        hash: 'e'.repeat(64),
    });
    const good = eventWithPoster({
        id: 31, title: 'STONEHAND', venue: 'DIESEL HALL', participants: 'STONEHAND',
        path: goodFact.imagePath, fact: goodFact, sourceType: 'vk',
    });
    const bad = eventWithPoster({
        id: 32, title: 'STONEHAND', venue: 'DIESEL HALL', participants: 'STONEHAND',
        path: badFact.imagePath, fact: badFact, sourceType: 'telegram',
    });
    const qtickets = {
        id: 33,
        sourceType: 'qtickets',
        partyPool: 'qtickets',
        title: 'STONEHAND — большой концерт',
        eventDate: '2026-09-20',
        venue: 'DIESEL HALL',
        imagePaths: [],
    };
    const result = dedupeAllPartiesRealtime([
        { ...bad, partyPool: 'primary' },
        { ...good, partyPool: 'primary' },
        qtickets,
    ]);
    assert.equal(result.events.length, 1);
    const [winner] = result.events;
    assert.equal(winner.sourceType, 'qtickets');
    assert.deepEqual(winner.verifiedImagePaths, [goodFact.imagePath]);
    assert.equal(eventHasSafePosterMatch(winner), true);
    assert.match(winner.posterMatchReason, /^all-party-donor:/u);
});


test('V188.99 screenshot-like duplicate swarm collapses to one metadata-rich canonical card', async () => {
    const goodPath = 'vk_announcements/harvest/canonical-1.jpg';
    const goodFact = posterFact({
        title: 'Праздник урожая',
        participants: 'Пахари Моря',
        venue: 'Башня, Винзавод',
        path: goodPath,
        hash: 'f'.repeat(64),
        confidence: 99,
        readability: 99,
    });
    const canonical = eventWithPoster({
        id: 101,
        title: 'Праздник урожая',
        venue: 'Башня, Винзавод',
        participants: 'Пахари Моря',
        path: goodPath,
        fact: goodFact,
        sourceType: 'vk',
    });
    const stale = [
        ['telegram', 102, 'Башня, Дивногорье', 'Дивные люди'],
        ['vk_chat', 103, 'Башня', 'Творческое объединение Из БЕРЛОГИ'],
        ['manual', 104, 'Башня', 'Осенняя обрядовая практика'],
        ['telegram', 105, 'Народный', ''],
        ['vk', 106, 'Центр Восточных практик', ''],
    ].map(([sourceType, id, venue, participants]) => ({
        id,
        sourceType,
        title: 'Праздник урожая',
        eventDate: '2026-09-20',
        eventTime: '17:00',
        venue,
        participants,
        imagePaths: [],
        verifiedImagePaths: [],
        posterImageIndex: 0,
        posterMatchStatus: 'no_safe_poster',
        posterVisionFacts: [],
        _dedupeRefs: [{ sourceType, id }],
    }));
    const result = await deduplicateEventsTwoContour([...stale, canonical]);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].venue, 'Башня, Винзавод');
    assert.deepEqual(result.events[0].imagePaths, [goodPath]);
    assert.equal(getEventPosterSafetyAssessment(result.events[0]).boundPath, goodPath);
});


test('V188.99 metadata anchor sweep never collapses two independently safe events at different named venues', async () => {
    const firstPath = 'vk_announcements/harvest/tower.jpg';
    const secondPath = 'telegram_announcements/harvest/orbita.jpg';
    const firstFact = posterFact({
        title: 'Праздник урожая',
        participants: 'Пахари Моря',
        venue: 'Башня, Винзавод',
        path: firstPath,
        hash: '1'.repeat(64),
        confidence: 99,
        readability: 99,
    });
    const secondFact = posterFact({
        title: 'Праздник урожая',
        participants: 'Пахари Моря',
        venue: 'ДК Орбита',
        path: secondPath,
        hash: '2'.repeat(64),
        confidence: 80,
        readability: 80,
    });
    const first = eventWithPoster({
        id: 201,
        title: 'Праздник урожая',
        venue: 'Башня, Винзавод',
        participants: 'Пахари Моря',
        path: firstPath,
        fact: firstFact,
        sourceType: 'vk',
    });
    const second = eventWithPoster({
        id: 202,
        title: 'Праздник урожая',
        venue: 'ДК Орбита',
        participants: 'Пахари Моря',
        path: secondPath,
        fact: secondFact,
        sourceType: 'telegram',
    });

    assert.equal(eventHasSafePosterMatch(first), true);
    assert.equal(eventHasSafePosterMatch(second), true);
    const comparison = compareEventsDeterministic(first, second);
    assert.equal(comparison.verdict, 'different');
    assert.ok(comparison.reasons.includes('hard-different-venue'));

    const result = await deduplicateEventsTwoContour([first, second]);
    assert.equal(result.events.length, 2);
    assert.equal(result.metadataAnchorSweepMergeCount, 0);
});
