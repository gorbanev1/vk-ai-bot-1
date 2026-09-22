import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    isLikelyEventAnnouncementImage,
} from '../../src/features/events/eventImageSelection.js';
import {
    imageFingerprintSetsReusable,
} from '../../src/features/events/sourcePostFingerprint.js';

test('V187.1 exports the image admission predicate required by eventAssets', () => {
    assert.equal(typeof isLikelyEventAnnouncementImage, 'function');
    assert.equal(isLikelyEventAnnouncementImage({ width: 96, height: 96, byteLength: 80_000 }), false);
    assert.equal(isLikelyEventAnnouncementImage({ width: 1080, height: 1350, byteLength: 250_000 }), true);
    assert.equal(isLikelyEventAnnouncementImage({ width: 0, height: 0, byteLength: 80_000 }), true);
    assert.equal(isLikelyEventAnnouncementImage({ width: 0, height: 0, byteLength: 4_000 }), false);
});

test('V187.1 exports the reusable fingerprint predicate required by eventVisionPolicy', () => {
    assert.equal(typeof imageFingerprintSetsReusable, 'function');
    const fp = [{ visualHash: 'same' }];
    assert.equal(imageFingerprintSetsReusable(fp, fp), true);
    assert.equal(imageFingerprintSetsReusable([], []), false);
    assert.equal(imageFingerprintSetsReusable(fp, [{ visualHash: 'other' }]), false);
});

test('V187.1 source import contracts name actual exports', () => {
    const assets = readFileSync(new URL('../../src/features/events/eventAssets.js', import.meta.url), 'utf8');
    const vision = readFileSync(new URL('../../src/features/events/eventVisionPolicy.js', import.meta.url), 'utf8');
    assert.match(assets, /isLikelyEventAnnouncementImage/u);
    assert.match(vision, /imageFingerprintSetsReusable/u);
});
