import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assignEventImageIndexesFromParsedFacts,
    evaluatePosterFactForEvent,
    extractPosterDateKeys,
    parseIndexedImageFacts,
} from '../../src/features/events/eventPosterMatching.js';
import {
    eventMatchesSearchFilters,
    inferVenueKey,
    normalizeEventSearchTag,
    parseEventSearchRequest,
} from '../../src/features/events/eventSearchTaxonomy.js';

test('V188.93 poster dates normalize numeric, Russian and English formats to the same day/month', () => {
    const keys = extractPosterDateKeys('15 сентября 2026; 15.09; 15.09.2026; 15/09; 15 September; 15 Sep');
    assert.deepEqual(keys, ['15-09']);
});

test('V188.93 distinctive title words rank the same poster while generic party words do not create identity', () => {
    const fact = {
        index: 1,
        poster: true,
        imageType: 'poster',
        posterConfidence: 95,
        textReadability: 90,
        title: 'MALINA',
        dates: '15 September 2026',
        participants: '',
        venue: 'Malina Lounge',
        text: 'MALINA · 15 SEPTEMBER',
    };
    const matched = evaluatePosterFactForEvent({ title: 'Malina Party', eventDate: '2026-09-15', venue: 'Malina Lounge' }, fact);
    assert.equal(matched.accepted, true);
    assert.ok(matched.score >= 130);
    assert.ok(matched.titleHits.includes('malina'));

    const dateOnly = evaluatePosterFactForEvent({ title: 'Party', eventDate: '2026-09-15', venue: 'Other' }, fact);
    // V188.99 intentionally supersedes the old V188.93 date-only fallback:
    // a same-day image still needs event-specific title/participant identity.
    assert.equal(dateOnly.accepted, false);
    assert.equal(dateOnly.reason, 'date-without-event-identity');
});

test('V188.93 one calendar poster with two dates can bind to both child event cards', () => {
    const facts = [{
        index: 1,
        poster: true,
        imageType: 'poster',
        posterConfidence: 98,
        textReadability: 95,
        title: 'Weekend schedule',
        dates: '18 сентября / 19 сентября',
        recognizedText: '18 сентября — Alpha\n19 сентября — Beta',
        participants: 'Alpha, Beta',
        venue: 'Liverpool',
        text: 'calendar poster',
    }];
    const events = assignEventImageIndexesFromParsedFacts([
        { title: 'Alpha', eventDate: '2026-09-18', venue: 'Liverpool' },
        { title: 'Beta', eventDate: '2026-09-19', venue: 'Liverpool' },
    ], facts);
    assert.deepEqual(events.map((event) => event.posterImageIndex), [1, 1]);
    assert.deepEqual(events.map((event) => event.imageIndexes), [[1], [1]]);
});

test('V188.93 parser stores poster tags independently from event card parsing', () => {
    const [fact] = parseIndexedImageFacts(`[IMAGE 1]\nТип изображения: poster\nЭто афиша события: да\nДата: 15 сентября\nНазвание: MALINA\nТеги: DJ, rave; techno\nРаспознанный текст: MALINA 15 сентября`);
    assert.deepEqual(fact.tags, ['DJ', 'rave', 'techno']);
});

test('V188.93 venue and tag search aliases preserve Diesel Bar/Hall distinction and broad Diesel search', () => {
    assert.equal(inferVenueKey('pub Liverpool'), 'liverpool');
    assert.equal(inferVenueKey('Rock Bar DIESEL'), 'diesel-bar');
    assert.equal(inferVenueKey('Дизель Холл'), 'diesel-hall');
    assert.notEqual(inferVenueKey('Rock Bar DIESEL'), inferVenueKey('Diesel Hall'));
    assert.equal(normalizeEventSearchTag('black-metal'), 'black-metal');
    assert.equal(normalizeEventSearchTag('блэк метал'), 'black-metal');

    const broad = parseEventSearchRequest('тусы дизель');
    assert.deepEqual(broad.venueKeys, ['diesel']);
    assert.equal(eventMatchesSearchFilters({ venue: 'Rock Bar DIESEL' }, broad), true);
    assert.equal(eventMatchesSearchFilters({ venue: 'Diesel Hall' }, broad), true);

    const exactHall = parseEventSearchRequest('тусы Diesel Hall');
    assert.deepEqual(exactHall.venueKeys, ['diesel-hall']);
    assert.equal(eventMatchesSearchFilters({ venue: 'Rock Bar DIESEL' }, exactHall), false);
    assert.equal(eventMatchesSearchFilters({ venue: 'Diesel Hall' }, exactHall), true);
});
