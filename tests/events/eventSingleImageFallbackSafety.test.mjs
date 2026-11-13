import assert from 'node:assert/strict';
import test from 'node:test';

import {
    eventHasSafePosterMatch,
    getEventSourceMediaBindingAssessment,
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

test('owner-verified singleton source binding is accepted by the provenance audit without Vision facts', () => {
    const event = fallbackEvent({
        posterMatchStatus: 'verified_single_event_source_media',
        posterMatchReason: 'source-photo-original-wall-969-owner-verified',
        posterVisionFacts: [],
    });
    const assessment = getEventSourceMediaBindingAssessment(event);
    assert.equal(assessment.accepted, true);
    assert.equal(assessment.reason, 'owner-verified-source-media-binding');
    assert.equal(assessment.boundPath, event.imagePaths[0]);
});

test('owner-verified provenance fallback stays fail-closed for ambiguous records', () => {
    const base = fallbackEvent({
        posterMatchStatus: 'verified_single_event_source_media',
        posterMatchReason: 'source-photo-original-wall-969-owner-verified',
        posterVisionFacts: [],
    });
    assert.equal(getEventSourceMediaBindingAssessment({ ...base, imagePaths: [base.imagePaths[0], 'vk_announcements/club/123-2.jpg'] }).accepted, false);
    assert.equal(getEventSourceMediaBindingAssessment({ ...base, posterImageIndex: 2 }).accepted, false);
    assert.equal(getEventSourceMediaBindingAssessment({ ...base, posterMatchReason: 'single-event-source-media-fallback' }).accepted, false);
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

test('singleton source-media binding keeps a specific image usable within a retained source gallery', () => {
    const event = fallbackEvent({
        isMultiAnnouncement: false,
        posterMatchReason: 'single-event-source-media-fallback',
        imagePaths: ['vk_announcements/club/123-1.jpg', 'vk_announcements/club/123-2.jpg'],
        posterVisionFacts: [{
            index: 1, poster: false, posterConfidence: 90, imageType: 'ordinary-photo',
            fallbackBinding: 'single-event-source-media', sourceMediaBinding: true,
            sourceEventCount: 1, sourceImageCount: 2,
            imagePath: 'vk_announcements/club/123-1.jpg', visionInspected: true, visionStatus: 'metadata_not_found',
        }],
    });
    const assessment = getEventPosterSafetyAssessment(event);
    assert.equal(assessment.accepted, true, 'an explicit mono-event source binding overrides poster metadata');
    assert.equal(assessment.reason, 'mono-announcement-source-image');
    const media = getEventSourceMediaBindingAssessment(event);
    assert.equal(media.accepted, true, 'the image remains source media even though it is not a poster');
    assert.deepEqual(media.paths, event.imagePaths);
    assert.equal(getEventSourceMediaBindingAssessment({ ...event, isMultiAnnouncement: true }).accepted, false);
});

test('mono-announcement source image remains visible when Vision finds no event metadata', () => {
    const imagePath = 'vk_announcements/club/123-1.jpg';
    const event = fallbackEvent({
        isMultiAnnouncement: false,
        posterMatchReason: 'single-event-source-media-fallback',
        imagePaths: [imagePath, 'vk_announcements/club/123-2.jpg'],
        posterVisionFacts: [{
            index: 1, poster: false, imageType: 'ordinary-photo',
            fallbackBinding: 'single-event-source-media', sourceMediaBinding: true,
            sourceEventCount: 1, sourceImageCount: 2, imagePath,
            visionInspected: true, visionStatus: 'metadata_not_found',
        }],
    });
    const assessment = getEventPosterSafetyAssessment(event);
    assert.equal(assessment.accepted, true);
    assert.equal(assessment.reason, 'mono-announcement-source-image');
    assert.equal(assessment.boundPath, imagePath);
    assert.equal(eventHasSafePosterMatch({ ...event, isMultiAnnouncement: true }), false);
});

test('ambiguous and explicitly multi-announcement records do not use the mono fallback', () => {
    const imagePath = 'vk_announcements/club/123-1.jpg';
    const candidate = fallbackEvent({
        posterMatchStatus: 'no_safe_poster',
        posterMatchReason: 'single-event-source-media-fallback',
        imagePaths: [imagePath, 'vk_announcements/club/123-2.jpg'],
        posterVisionFacts: [{
            index: 1, poster: false, imageType: 'ordinary-photo',
            fallbackBinding: 'single-event-source-media', sourceMediaBinding: true,
            sourceEventCount: 1, sourceImageCount: 2, imagePath,
        }],
    });
    assert.equal(eventHasSafePosterMatch({ ...candidate, isMultiAnnouncement: true }), false);
    assert.equal(eventHasSafePosterMatch({ ...candidate, isMultiAnnouncement: undefined }), false);
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

test('mono poster bindings preserve an exact owner confirmation through dedupe', () => {
    const imagePath = 'vk_announcements/rb_diesel/13733-1.jpg';
    const event = fallbackEvent({
        id: 138, title: 'Manhunt Tour', eventDate: '2026-10-23',
        isMultiAnnouncement: false, imagePaths: [imagePath], posterImageIndex: 1,
        posterMatchStatus: 'exact_poster_match',
        posterMatchReason: 'owner-confirmed-poster-for-this-event-manual-recovery-20261023',
        posterVisionFacts: [{
            index: 1, imagePath, poster: true, posterConfidence: 98,
            ownerConfirmedBinding: {
                eventId: 138, eventTitle: 'Manhunt Tour', eventDate: '2026-10-23',
                imageIndex: 1, imagePath, decision: 'yes', at: 1792743890,
            },
        }],
    });
    const assessment = getEventPosterSafetyAssessment(event);
    assert.equal(assessment.accepted, true);
    assert.equal(assessment.ownerConfirmed, true);
    assert.equal(assessment.boundPath, imagePath);
    for (const changed of [
        { ...event, id: 139 },
        { ...event, title: 'Другое событие' },
        { ...event, eventDate: '2026-10-24' },
    ]) {
        const stale = getEventPosterSafetyAssessment(changed);
        assert.equal(stale.accepted, false);
        assert.equal(stale.ownerConfirmed, false);
    }
});

test('a multi-announcement shared source image is safe only with an exact one-path binding', () => {
    const imagePath = 'vk_announcements/club/123-1.jpg';
    const shared = {
        title: 'One child event',
        eventDate: '2026-10-12',
        isMultiAnnouncement: true,
        imagePaths: [imagePath],
        posterImageIndex: 1,
        posterMatchStatus: 'shared_multi_event_source_image',
        posterMatchReason: 'multi-event-shared-source-image',
        posterVisionFacts: [{
            index: 1,
            poster: false,
            visionStatus: 'error',
            fallbackBinding: 'multi-event-shared-source-image',
            sourceMediaBinding: true,
            sourceEventCount: 3,
            sourceImageCount: 1,
            imagePath,
        }],
    };
    assert.equal(eventHasSafePosterMatch(shared), true);
    assert.equal(eventHasSafePosterMatch({ ...shared, imagePaths: ['vk_announcements/club/other-1.jpg'] }), false);
    assert.equal(eventHasSafePosterMatch({ ...shared, imagePaths: [imagePath, 'vk_announcements/club/other-2.jpg'] }), false);
    assert.equal(eventHasSafePosterMatch({ ...shared, isMultiAnnouncement: false }), false);
});
