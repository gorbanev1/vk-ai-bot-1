import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventPosterSafetyAssessment } from '../../src/features/events/eventProvenance.js';
import { mergeDuplicateEvents } from '../../src/features/events/eventDuplicateResolution.js';

const event = ({ index = 0, imagePath = 'telegram_announcements/a/123-1.jpg', factPath = imagePath, status = 'verified_single_event_source_media', facts = null } = {}) => ({
    title: 'Жажда Кайфа', eventDate: '2026-09-25', venue: 'Котельная', participants: 'tsuefa!, TWIN’79',
    imagePaths: [imagePath], posterImageIndex: index, posterMatchStatus: status,
    posterVisionFacts: facts ?? [{
        index: 1, poster: true, imageType: 'poster', posterConfidence: 99, title: 'Жажда Кайфа',
        dates: '25 сентября', participants: 'tsuefa!, TWIN’79', imagePath: factPath,
    }],
});

test('lost index is recovered only from one path-bound, matching poster fact', () => {
    const input = event();
    const result = getEventPosterSafetyAssessment(input);
    assert.equal(result.accepted, true);
    assert.equal(result.selectedIndex, 1);
    assert.equal(result.recoveredMissingIndex, true);
    assert.equal(result.boundPath, input.imagePaths[0]);
    assert.equal(input.posterImageIndex, 0, 'read-only recovery must not mutate stored input');
});

test('a missing index does not authorize a mismatched image or date', () => {
    assert.equal(getEventPosterSafetyAssessment(event({ factPath: 'telegram_announcements/a/other.jpg' })).accepted, false);
    assert.equal(getEventPosterSafetyAssessment(event({ facts: [{ index: 1, poster: true, title: 'Другое событие', dates: '25 сентября', imagePath: 'telegram_announcements/a/123-1.jpg' }] })).accepted, false);
    assert.equal(getEventPosterSafetyAssessment(event({ facts: [{ index: 1, poster: true, title: 'Жажда Кайфа', dates: '26 сентября', imagePath: 'telegram_announcements/a/123-1.jpg' }] })).accepted, false);
    assert.equal(getEventPosterSafetyAssessment(event({ facts: [] })).accepted, false);
});

test('ambiguous multiple facts cannot infer a poster index', () => {
    const a = event();
    const repeated = { ...a.posterVisionFacts[0], index: 2 };
    assert.equal(getEventPosterSafetyAssessment({ ...a, posterVisionFacts: [...a.posterVisionFacts, repeated] }).accepted, false);
    assert.equal(getEventPosterSafetyAssessment({ ...a, imagePaths: [...a.imagePaths, 'telegram_announcements/a/123-2.jpg'] }).accepted, false);
});

test('unverified/no-safe events stay text-only, explicit invalid index never silently changes', () => {
    for (const status of ['no_safe_poster', 'poster_review_required', 'legacy_manual_poster']) {
        assert.equal(getEventPosterSafetyAssessment(event({ status })).accepted, false);
    }
    assert.equal(getEventPosterSafetyAssessment(event({ index: 9 })).accepted, false);
});

test('recovered index is passed through confirmed event-dedupe poster binding', () => {
    const source = { ...event(), id: 200, sourceType: 'telegram', sourceUrl: 'https://t.me/fixture/123' };
    const other = { ...source, id: 201, sourceType: 'vk', imagePaths: [], posterVisionFacts: [], posterMatchStatus: 'no_safe_poster' };
    const result = mergeDuplicateEvents(source, other);
    const safety = getEventPosterSafetyAssessment(result);
    assert.equal(safety.accepted, true);
    assert.equal(safety.boundPath, source.imagePaths[0]);
    assert.equal(result.posterImageIndex, 1);
});
