import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisionBoundSourcePosterPaths } from '../../src/features/events/visionBoundSourcePoster.js';

function fixture(overrides = {}) {
    return {
        isMultiAnnouncement: true,
        title: 'Rock Night',
        eventDate: '2026-10-24',
        venue: 'The Last of Vavilone',
        sourceImagePaths: ['source/cover.jpg', 'source/rock-night.jpg', 'source/other.jpg'],
        imageVisionFacts: [{
            index: 2, poster: true, imageType: 'poster', posterConfidence: 100, textReadability: 98,
            title: 'Rock Night', dates: '24 October', recognizedText: 'Rock Night 24 October',
        }],
        ...overrides,
    };
}

test('restores only the exact image path for one accepted Vision fact', () => {
    const event = fixture({ imagePaths: ['legacy/wrong-poster.jpg'] });
    assert.deepEqual(getVisionBoundSourcePosterPaths(event), ['source/rock-night.jpg']);
});

test('does not guess when multiple images are accepted for one event', () => {
    const event = fixture({ imageVisionFacts: [
        ...fixture().imageVisionFacts,
        { ...fixture().imageVisionFacts[0], index: 3 },
    ] });
    assert.deepEqual(getVisionBoundSourcePosterPaths(event), []);
});

test('rejects non-posters, invalid indexes, and generated fallback images', () => {
    assert.deepEqual(getVisionBoundSourcePosterPaths(fixture({ imageVisionFacts: [
        { ...fixture().imageVisionFacts[0], poster: false },
        { ...fixture().imageVisionFacts[0], index: 9 },
        { ...fixture().imageVisionFacts[0], index: 1 },
    ], sourceImagePaths: ['event_generated_fallbacks/rock-event.png'] })), []);
});

test('keeps mono-announcement media outside this recovery path', () => {
    assert.deepEqual(getVisionBoundSourcePosterPaths(fixture({ isMultiAnnouncement: false })), []);
});
