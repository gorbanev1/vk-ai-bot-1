import assert from 'node:assert/strict';
import test from 'node:test';

import {
    eventHasSafePosterMatch,
    getEventPosterSafetyAssessment,
} from '../../src/features/events/eventProvenance.js';

function fallbackEvent(overrides = {}) {
    const imagePath = 'vk_announcements/club/123-1.jpg';
    return {
        id: 123,
        title: 'Noise Night',
        eventDate: '2026-10-12',
        imagePaths: [imagePath],
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
            imagePath,
            text: '',
        }],
        ...overrides,
    };
}

test('single event with one source image remains renderable when Vision returned no block', () => {
    const assessment = getEventPosterSafetyAssessment(fallbackEvent());
    assert.equal(assessment.accepted, true);
    assert.equal(assessment.reason, 'single-event-single-source-image-fallback');
    assert.equal(assessment.boundPath, 'vk_announcements/club/123-1.jpg');
    assert.equal(eventHasSafePosterMatch(fallbackEvent()), true);
});

test('single-image fallback is fail-closed when path binding is ambiguous or generated', () => {
    assert.equal(eventHasSafePosterMatch(fallbackEvent({
        imagePaths: ['vk_announcements/club/123-1.jpg', 'vk_announcements/club/123-2.jpg'],
    })), false);
    assert.equal(eventHasSafePosterMatch(fallbackEvent({
        imagePaths: ['event_message_cards/123-event-1.png'],
        posterVisionFacts: [{
            index: 1, poster: true, posterConfidence: 55, imageType: 'source-image-fallback',
            fallbackBinding: 'single-event-single-image', sourceEventCount: 1, sourceImageCount: 1,
            imagePath: 'event_message_cards/123-event-1.png', text: '',
        }],
    })), false);
});

test('ordinary Vision-positive metadata still follows normal strict matching', () => {
    const event = fallbackEvent({
        posterMatchReason: 'date+title-majority',
        posterVisionFacts: [{
            index: 1, poster: true, posterConfidence: 99, imageType: 'poster',
            title: 'Noise Night', dates: '12 октября 2026',
            recognizedText: 'Noise Night · 12 октября 2026',
            imagePath: 'vk_announcements/club/123-1.jpg',
        }],
    });
    assert.equal(eventHasSafePosterMatch(event), true);
});
