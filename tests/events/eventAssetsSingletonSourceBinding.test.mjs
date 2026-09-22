import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareEventImages } from '../../src/features/events/eventAssets.js';
import { eventHasSafePosterMatch } from '../../src/features/events/eventProvenance.js';

function sourcePng() {
    const bytes = Buffer.alloc(1400, 7);
    bytes.writeUInt32BE(0x89504e47, 0);
    bytes.writeUInt32BE(200, 16);
    bytes.writeUInt32BE(200, 20);
    return bytes;
}

function mockFetch() {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => ({
        ok: true,
        url,
        headers: { get: (name) => name === 'content-type' ? 'image/png' : '' },
        arrayBuffer: async () => sourcePng(),
    });
    return () => { globalThis.fetch = original; };
}

test('one event plus one source image keeps the image even when Vision says ordinary photo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-assets-singleton-'));
    const restore = mockFetch();
    try {
        const [event] = await prepareEventImages({
            events: [{
                title: 'Noise Night', eventDate: '2026-10-12',
                posterVisionFacts: [{ index: 1, poster: false, imageType: 'ordinary-photo', text: 'обычное фото' }],
            }],
            sourceKey: 'vk:test', itemId: 'post-1',
            imageUrls: ['https://cdn.example.test/one.png'],
            dataDirectory: root, allowBrowserFallback: false,
        });
        assert.equal(event.imagePaths.length, 1);
        assert.equal(event.posterImageIndex, 1);
        assert.equal(event.posterVisionFacts[0].poster, false);
        assert.equal(event.posterVisionFacts[0].sourceMediaBinding, true);
        assert.equal(eventHasSafePosterMatch(event), true);
        assert.ok((await readFile(join(root, event.imagePaths[0]))).length > 1000);
    } finally {
        restore();
    }
});

test('one source image is not shared across multi-announcement events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-assets-multi-'));
    const restore = mockFetch();
    try {
        const events = await prepareEventImages({
            events: [{ title: 'A', eventDate: '2026-10-12' }, { title: 'B', eventDate: '2026-10-13' }],
            sourceKey: 'vk:test', itemId: 'post-2',
            imageUrls: ['https://cdn.example.test/one.png'],
            dataDirectory: root, allowBrowserFallback: false,
        });
        assert.deepEqual(events.map((event) => event.imagePaths), [[], []]);
    } finally {
        restore();
    }
});
