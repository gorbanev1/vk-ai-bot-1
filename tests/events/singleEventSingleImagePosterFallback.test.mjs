import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePosterFactForEvent } from '../../src/features/events/eventPosterMatching.js';
import { eventHasSafePosterMatch, getEventPosterSafetyAssessment } from '../../src/features/events/eventProvenance.js';

function fallbackEvent(path = 'vk_announcements/demo/42-1.jpg') {
    return {
        title: 'Alpha Night',
        eventDate: '2026-09-20',
        venue: 'Башня',
        imagePaths: [path],
        posterImageIndex: 1,
        posterMatchStatus: 'verified_single_event_source_media',
        posterMatchReason: 'single-event-single-source-image-fallback',
        posterVisionFacts: [{
            index: 1,
            poster: true,
            posterConfidence: 55,
            imageType: 'source-image-fallback',
            fallbackBinding: 'single-event-single-image',
            sourceEventCount: 1,
            sourceImageCount: 1,
            imagePath: path,
        }],
    };
}

test('single event/single source image fallback is safely renderable and path-bound', () => {
    const event = fallbackEvent();
    const fact = event.posterVisionFacts[0];
    const match = evaluatePosterFactForEvent(event, fact);
    assert.equal(match.accepted, true);
    assert.equal(match.reason, 'single-event-single-source-image');
    assert.equal(eventHasSafePosterMatch(event), true);
    assert.equal(getEventPosterSafetyAssessment(event).boundPath, event.imagePaths[0]);
});

test('fallback image cannot be rebound to a different path', () => {
    const event = fallbackEvent('vk_announcements/demo/42-2.jpg');
    event.imagePaths = ['vk_announcements/demo/42-1.jpg'];
    assert.equal(eventHasSafePosterMatch(event), false);
    assert.equal(getEventPosterSafetyAssessment(event).reason, 'invalid-single-source-image-fallback');
});

test('explicitly rejected Vision image remains unsafe even for a one-image event', () => {
    const event = fallbackEvent();
    event.posterVisionFacts[0].poster = false;
    assert.equal(eventHasSafePosterMatch(event), false);
});
