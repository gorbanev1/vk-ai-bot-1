import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createQticketsDomSnapshot } from '../../src/platforms/qtickets/qticketsDomSnapshot.js';

test('QTickets DOM snapshot stores full pages and replaces only its dedicated previous snapshot', () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'qtickets-dom-'));
    try {
        const snapshot = createQticketsDomSnapshot({ dataDirectory, runId: 'first' });
        snapshot.savePage({
            kind: 'listing',
            url: 'https://voronezh.qtickets.events/',
            html: '<html><body>complete listing</body></html>',
            metadata: { parsedCardCount: 1 },
        });
        snapshot.record({ kind: 'detail-error', url: 'https://voronezh.qtickets.events/2', metadata: { error: 'timeout' } });
        snapshot.finish('completed-with-detail-errors', { selectedCards: 2 });

        const root = join(dataDirectory, 'qtickets-dom-snapshot');
        const firstManifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
        assert.equal(firstManifest.pages.length, 2);
        assert.equal(firstManifest.pages[0].htmlBytes, Buffer.byteLength('<html><body>complete listing</body></html>'));
        assert.equal(firstManifest.status, 'completed-with-detail-errors');
        assert.match(readFileSync(join(root, firstManifest.pages[0].file), 'utf8'), /complete listing/u);

        writeFileSync(join(root, 'stale-dom.html'), 'stale');
        writeFileSync(join(dataDirectory, 'unrelated.txt'), 'preserve');
        const next = createQticketsDomSnapshot({ dataDirectory, runId: 'second' });
        next.finish();
        assert.deepEqual(readdirSync(root), ['manifest.json']);
        assert.equal(readFileSync(join(dataDirectory, 'unrelated.txt'), 'utf8'), 'preserve');
    } finally {
        rmSync(dataDirectory, { recursive: true, force: true });
    }
});
