import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualParserDiagnostics } from '../../src/features/scrapers/manualParserDiagnostics.js';
import { createVkFinalDomCapture } from '../../src/features/scrapers/vkDomFinalSnapshot.js';
import { verifyVkFinalDomSnapshot } from '../../scripts/vk-dom-final-verify.mjs';

const makePage = (html) => ({
    isClosed: () => false,
    evaluate: async (_fn, args) => args?.includeStructure ? ({
        html, capturedAt: '2026-09-20T12:00:00.000Z',
        state: { pageUrl: 'https://vk.ru/im?sel=c22', baseUri: 'https://vk.ru/',
            scrollY: 0, viewport: { width: 1200, height: 800 } },
        resources: [], structure: { nodeCount: 0, elements: [], postLinkCandidates: [] },
    }) : html,
});

test('parser-all checkpoints initial and +30% growth only from existing native DOM observations', async () => {
    const data = await mkdtemp(join(tmpdir(), 'vk-native-checkpoint-'));
    const diagnostics = createManualParserDiagnostics({ dataDirectory: data, label: 'parser-all' });
    const base = `<html><body>${'а'.repeat(1000)}</body></html>`;
    const grown = `<html><body>${'а'.repeat(1500)}</body></html>`;
    const first = await diagnostics.captureVkDomFixture({ page: makePage(base), sourceId: 'chat:c22', label: 'window-1' });
    const second = await diagnostics.captureVkDomFixture({ page: makePage(grown), sourceId: 'chat:c22', label: 'window-2' });
    const third = await diagnostics.captureVkDomFixture({ page: makePage(grown), sourceId: 'chat:c22', label: 'window-3' });
    assert.equal(first.html, base);
    assert.equal(second.html, grown);
    assert.equal(third.html, grown);
    assert.equal(first.persisted, false);
    const final = await diagnostics.captureVkFinalDomSnapshot({ page: makePage(grown),
        sourceId: 'chat:c22', direction: 'up', sourceKind: 'vk-chat',
        preparation: { direction: 'up', status: 'native-capture-finished-no-extra-pagination', progress: [] } });
    const checkpoints = JSON.parse(await readFile(join(final.directory, 'checkpoints', 'index.json'), 'utf8'));
    assert.equal(checkpoints.checkpoints.length, 2);
    assert.equal(checkpoints.checkpoints[0].reason, 'initial-observation');
    assert.equal(checkpoints.checkpoints[1].reason, 'growth-30-percent');
    assert.equal(await readFile(join(final.directory, 'dom.raw.html'), 'utf8'), grown);
    assert.equal(await readFile(join(final.directory, 'latest.dom.raw.html'), 'utf8'), grown);
    assert.equal(await readFile(join(final.directory, 'checkpoints', '001.dom.raw.html'), 'utf8'), base);
    assert.equal(await readFile(join(final.directory, 'checkpoints', '002.dom.raw.html'), 'utf8'), grown);
    assert.equal((await readdir(join(diagnostics.directory, 'vk-dom-final-snapshots'))).length, 1);
    await assert.rejects(stat(join(diagnostics.directory, 'vk-dom-fixtures')), /ENOENT/);
    assert.equal((await verifyVkFinalDomSnapshot(final.directory)).captureIsOfflineReproducible, true);
});

test('forensic snapshot module never requires a second source-native scroll', async () => {
    const code = await readFile(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
    const nativeCapture = code.slice(code.indexOf('// V188.141: Final forensic DOM is OBSERVATIONAL.'),
        code.indexOf('const sourceId = `chat:${peerId}`;', code.indexOf('// V188.141: Final forensic DOM is OBSERVATIONAL.')));
    assert.ok(nativeCapture.includes('captureVkFinalDomSnapshot'));
    assert.doesNotMatch(nativeCapture, /(?:await\s+(?:.*\.)?scroll|moveToEdge\s*\(|prepareVkFinalDomCapture\s*\()/iu);
});
