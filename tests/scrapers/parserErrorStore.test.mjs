import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { createManualParserDiagnostics } from '../../src/features/scrapers/manualParserDiagnostics.js';
import { listParserErrors, updateParserError } from '../../src/features/scrapers/parserErrorStore.js';

test('parser item failures retain complete DOM, raw cache, trace, and retry history', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'parser-error-store-'));
    const item = { postId: 42, text: 'Original event announcement', contentHash: 'same-content', imageUrls: [] };
    const errorInput = {
        sourceId: 'vk:venue', sourceLabel: 'Venue', sourceKind: 'vk-public', itemId: '42', item,
        sourceUrl: 'https://vk.ru/wall-1_42', stage: 'event-extraction', error: new Error('simulated parser failure'),
    };

    try {
        const first = createManualParserDiagnostics({ dataDirectory, label: 'parser-errors-replay' });
        const firstDom = '<html><body><article>complete original DOM</article></body></html>';
        const firstDomPath = await first.captureDomSnapshot({ sourceId: 'vk:venue', html: firstDom, label: 'final' });
        const firstCachePath = first.cacheSource({ sourceId: 'vk:venue', kind: 'vk-public', items: [item] });
        const firstError = await first.onParserItemError(errorInput);
        first.finish({ failed: 1 });

        assert.ok(existsSync(firstError.archiveDirectory));
        assert.match(readFileSync(firstError.domPath, 'utf8'), /complete original DOM/u);
        assert.equal(JSON.parse(readFileSync(firstError.rawCachePath, 'utf8')).items[0].postId, 42);
        assert.ok(existsSync(firstError.tracePath));
        assert.ok(firstDomPath);
        assert.ok(firstCachePath);

        updateParserError(dataDirectory, firstError.id, {
            replayAttempt: { at: new Date().toISOString(), replayRunId: 'test-replay', ok: false, reason: 'still failing' },
        });

        const second = createManualParserDiagnostics({ dataDirectory, label: 'parser-errors-replay' });
        const secondDom = '<html><body><article>second attempt DOM</article></body></html>';
        await second.captureDomSnapshot({ sourceId: 'vk:venue', html: secondDom, label: 'final' });
        second.cacheSource({ sourceId: 'vk:venue', kind: 'vk-public', items: [item] });
        const secondError = await second.onParserItemError(errorInput);
        second.finish({ failed: 1 });

        const [current] = listParserErrors({ dataDirectory });
        assert.equal(current.id, firstError.id);
        assert.equal(current.status, 'open');
        assert.equal(current.originalRunId, first.runId);
        assert.equal(current.originalArchiveDirectory, firstError.archiveDirectory);
        assert.equal(current.archiveDirectory, secondError.archiveDirectory);
        assert.equal(current.evidenceHistory.some((entry) => entry.runId === first.runId), true);
        assert.match(readFileSync(join(firstError.archiveDirectory, basename(firstDomPath)), 'utf8'), /complete original DOM/u);
        assert.match(readFileSync(current.domPath, 'utf8'), /second attempt DOM/u);
        assert.equal(current.replayAttempts.length, 1);
        assert.equal(current.replayAttempts[0].ok, false);
        assert.ok(existsSync(current.tracePath));
        assert.ok(existsSync(current.rawCachePath));
    } finally {
        rmSync(dataDirectory, { recursive: true, force: true });
    }
});
