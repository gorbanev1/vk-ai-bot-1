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


test('successful parser runs keep their forensic files without a duplicate error archive', () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'parser-success-store-'));
    try {
        const diagnostics = createManualParserDiagnostics({ dataDirectory, label: 'parser-all-clean' });
        const cachePath = diagnostics.cacheSource({ sourceId: 'vk:venue', kind: 'vk-public', items: [{ postId: 1 }] });
        diagnostics.finish({ failed: 0 });
        assert.ok(existsSync(cachePath));
        assert.match(readFileSync(diagnostics.logPath, 'utf8'), /run.finish/);
        assert.equal(existsSync(join(dataDirectory, 'parser-error-archives', diagnostics.runId)), false);
        assert.deepEqual(listParserErrors({ dataDirectory }), []);
    } finally { rmSync(dataDirectory, { recursive: true, force: true }); }
});

test('an explicitly requested archive is refreshed even without indexed errors', () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'parser-explicit-store-'));
    try {
        const diagnostics = createManualParserDiagnostics({ dataDirectory, label: 'parser-all-clean' });
        const archive = diagnostics.archiveRun({ reason: 'explicit diagnostic capture' });
        diagnostics.log('late-evidence', { kept: true });
        diagnostics.finish({ failed: 0 });
        const trace = readFileSync(join(archive, basename(diagnostics.logPath)), 'utf8');
        assert.match(trace, /late-evidence/);
        assert.match(trace, /run.finish/);
    } finally { rmSync(dataDirectory, { recursive: true, force: true }); }
});

test('final refresh updates all run errors in one index write and preserves other runs and retry history', async () => {
    const { default: fs } = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const { recordParserError, refreshParserErrorEvidence } = await import('../../src/features/scrapers/parserErrorStore.js');
    const dataDirectory = mkdtempSync(join(tmpdir(), 'parser-batch-store-'));
    const originalRead = fs.readFileSync, originalWrite = fs.writeFileSync;
    try {
        const runDirectory = join(dataDirectory, 'run');
        fs.mkdirSync(runDirectory);
        fs.writeFileSync(join(runDirectory, 'trace.jsonl'), 'initial');
        const records = [];
        for (let i = 0; i < 4; i++) records.push(recordParserError({
            dataDirectory, runDirectory, runId: 'batch-run', sourceId: 'vk:venue', itemId: String(i),
            details: { traceRelativePath: 'trace.jsonl' }, status: i === 0 ? 'resolved' : 'open',
        }));
        const unrelated = recordParserError({ dataDirectory, runId: 'other-run', sourceId: 'vk:other', itemId: '0' });
        updateParserError(dataDirectory, records[1].id, { replayAttempt: { ok: false, reason: 'previous retry' } });
        fs.writeFileSync(join(runDirectory, 'trace.jsonl'), 'final evidence');
        const indexPath = join(dataDirectory, 'parser-error-archives', 'errors.json');
        let reads = 0, writes = 0;
        fs.readFileSync = function(file, ...args) {
            if (String(file) === indexPath) reads++;
            return originalRead.call(this, file, ...args);
        };
        fs.writeFileSync = function(file, ...args) {
            if (String(file).startsWith(indexPath + '.tmp-')) writes++;
            return originalWrite.call(this, file, ...args);
        };
        syncBuiltinESMExports();
        assert.equal(refreshParserErrorEvidence({ dataDirectory, runDirectory, runId: 'batch-run' }), 4);
        assert.equal(reads, 1); assert.equal(writes, 1);
        fs.readFileSync = originalRead; fs.writeFileSync = originalWrite; syncBuiltinESMExports();
        const all = listParserErrors({ dataDirectory, includeResolved: true });
        assert.deepEqual(all.find(row => row.id === unrelated.id), unrelated);
        for (const record of records) {
            const current = all.find(row => row.id === record.id);
            assert.equal(readFileSync(current.tracePath, 'utf8'), 'final evidence');
            assert.equal(current.status, record.status);
            assert.equal(current.originalRunId, record.originalRunId);
        }
        assert.equal(all.find(row => row.id === records[1].id).replayAttempts.length, 1);
    } finally {
        fs.readFileSync = originalRead; fs.writeFileSync = originalWrite; syncBuiltinESMExports();
        rmSync(dataDirectory, { recursive: true, force: true });
    }
});
