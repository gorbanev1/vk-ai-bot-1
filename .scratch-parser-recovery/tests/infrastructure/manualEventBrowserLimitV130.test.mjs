import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

test('V130 manual event link scanner auto-parses at most 20 posts and leaves tab open', () => {
    assert.match(source, /MANUAL_EVENT_AUTO_POST_LIMIT\s*=\s*20/u);
    assert.match(source, /posts\.length\s*>=\s*postLimit/u);
    assert.match(source, /remaining=manual-scroll/u);
    assert.doesNotMatch(source, /posts\.length\s*>=\s*200/u);
});
