import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isMultiAnnouncementForImageDelivery,
    shouldRejectImageFactForDelivery,
} from '../../src/features/events/eventImageDeliveryPolicy.js';
import { eventHasSafePosterMatch } from '../../src/features/events/eventProvenance.js';

test('ordinary photos and explicit negative poster facts stay displayable for a mono announcement', () => {
    const event = { isMultiAnnouncement: false };
    assert.equal(isMultiAnnouncementForImageDelivery(event, true), false);
    assert.equal(shouldRejectImageFactForDelivery(event, {
        poster: false,
        imageType: 'ordinary-photo',
    }, true), false);
});

test('source-bound ordinary-photo is accepted for a mono card regardless of Vision poster flag', () => {
    const mono = {
        isMultiAnnouncement: false,
        imagePaths: ['source/post-1.jpg'],
        posterImageIndex: 1,
        posterMatchStatus: 'no_safe_poster',
        posterVisionFacts: [{
            index: 1, poster: false, imageType: 'ordinary-photo',
            fallbackBinding: 'single-event-single-image', sourceMediaBinding: true,
            sourceEventCount: 1, sourceImageCount: 1, imagePath: 'source/post-1.jpg',
        }],
    };
    assert.equal(eventHasSafePosterMatch(mono), true);
    assert.equal(eventHasSafePosterMatch({ ...mono, isMultiAnnouncement: true }), false);
});

test('multi announcements still reject an image that Vision did not match to an event', () => {
    const event = { isMultiAnnouncement: true };
    assert.equal(isMultiAnnouncementForImageDelivery(event, false), true);
    assert.equal(shouldRejectImageFactForDelivery(event, {
        poster: false,
        imageType: 'ordinary-photo',
    }), true);
    assert.equal(shouldRejectImageFactForDelivery(event, {
        poster: true,
        imageType: 'poster',
    }), false);
});

test('stored mono/multi classification wins over neighboring cards from the same post', () => {
    assert.equal(isMultiAnnouncementForImageDelivery({ isMultiAnnouncement: false }, true), false);
    assert.equal(isMultiAnnouncementForImageDelivery({ isMultiAnnouncement: true }, false), true);
});
