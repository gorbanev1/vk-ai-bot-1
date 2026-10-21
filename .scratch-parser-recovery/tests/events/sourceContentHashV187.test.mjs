import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createStableSourceContentHash,
    createLegacyVersionedSourceContentHash,
    sourceContentHashMatches,
} from '../../src/features/events/sourceContentHash.js';

const post = {
    text: 'Концерт 18 сентября',
    imageUrls: ['https://example.test/a.jpg'],
    publishedAt: 1788739200,
};

test('V187 stable content hash ignores parser release version', () => {
    const stable = createStableSourceContentHash(post, { reparseEpoch: '' });
    assert.equal(stable, createStableSourceContentHash({ ...post }, { reparseEpoch: '' }));
});

test('V187 accepts V186 version-coupled hash without reparsing', () => {
    const legacyVersion = 'telegram-playwright-v186-five-round-token-safe-vision';
    const legacyHash = createLegacyVersionedSourceContentHash(post, legacyVersion);
    assert.equal(sourceContentHashMatches(legacyHash, post, {
        legacyParserVersions: [legacyVersion],
        reparseEpoch: '',
    }), true);
});

test('V187 content changes still require processing', () => {
    const stable = createStableSourceContentHash(post, { reparseEpoch: '' });
    assert.equal(sourceContentHashMatches(stable, { ...post, text: `${post.text}!` }, {
        reparseEpoch: '',
    }), false);
});

test('explicit reparse epoch intentionally invalidates old hashes', () => {
    const stable = createStableSourceContentHash(post, { reparseEpoch: '' });
    assert.equal(sourceContentHashMatches(stable, post, {
        reparseEpoch: 'manual-reparse-1',
    }), false);
});
