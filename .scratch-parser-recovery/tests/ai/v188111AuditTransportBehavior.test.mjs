import test from 'node:test';
import assert from 'node:assert/strict';
import {
    executeRuntimeModelFailover,
    isTechnicalModelFailure,
} from '../../src/features/ai/modelProviderFailover.js';
import {
    buildPatchedProjectZip,
    parseProjectZipArchive,
    verifyProjectZipEntries,
} from '../../src/features/audit/projectArchiveAudit.js';

const candidates = [{ provider: 'compat', name: 'test', secret: 'local-only', baseUrl: 'https://invalid.local/v1' }];
const failoverSettings = {
    candidates, failuresBeforeQuarantine: 2, maxRounds: 1,
    useCredentialHealth: false, sleep: async () => {},
};

test('successful paid model request is never retried when success telemetry throws', async () => {
    let paidCalls = 0;
    const result = await executeRuntimeModelFailover({
        ...failoverSettings,
        request: async () => { paidCalls += 1; return 'completed'; },
        onEvent: (event) => { if (event.type === 'success') throw new Error('telemetry crashed'); },
    });
    assert.equal(paidCalls, 1);
    assert.equal(result.value, 'completed');
});

test('asynchronously rejected telemetry is not a model failure', async () => {
    let paidCalls = 0;
    const result = await executeRuntimeModelFailover({
        ...failoverSettings,
        request: async () => { paidCalls += 1; return 'completed'; },
        onEvent: async (event) => { if (event.type === 'success') throw new Error('async telemetry crashed'); },
    });
    assert.equal(paidCalls, 1);
    assert.equal(result.value, 'completed');
});

test('known/possibly started inference never triggers general failover', async () => {
    for (const evidence of [
        { responseId: 'resp_1', retryable: true },
        { inferenceMayHaveStarted: true, retryable: true },
        { inferenceCompleted: true, retryable: true },
        { streamOutputStarted: true, retryable: true },
    ]) {
        const failure = Object.assign(new Error('network timeout'), evidence);
        assert.equal(isTechnicalModelFailure(failure), false);
        let paidCalls = 0;
        await assert.rejects(executeRuntimeModelFailover({
            ...failoverSettings,
            request: async () => { paidCalls += 1; throw failure; },
        }), (caught) => caught === failure);
        assert.equal(paidCalls, 1);
    }
});

test('ZIP CRC verification releases per-entry inflated buffers', () => {
    const zipped = buildPatchedProjectZip(
        { entries: [], readEntry() { return Buffer.alloc(0); } },
        { additions: new Map([['a.txt', 'first entry'], ['b.txt', 'second entry']]) },
    );
    const parsed = parseProjectZipArchive(zipped);
    assert.equal(verifyProjectZipEntries(parsed), parsed);
    assert.ok(parsed.entries.every((entry) => entry.data === null));
    assert.equal(parsed.readEntry(parsed.entries[0]).toString(), 'first entry');
});

test('ZIP validator rejects local header method mismatch and incorrect directory size', () => {
    const zipped = buildPatchedProjectZip(
        { entries: [], readEntry() { return Buffer.alloc(0); } },
        { additions: new Map([['a.txt', 'first entry']]) },
    );
    const brokenLocal = Buffer.from(zipped);
    brokenLocal.writeUInt16LE(brokenLocal.readUInt16LE(8) === 8 ? 0 : 8, 8);
    const parsed = parseProjectZipArchive(brokenLocal);
    assert.throws(() => verifyProjectZipEntries(parsed), /local\/central flags or compression mismatch/u);

    const brokenDirectory = Buffer.from(zipped);
    const eocd = brokenDirectory.length - 22;
    brokenDirectory.writeUInt32LE(brokenDirectory.readUInt32LE(eocd + 12) - 1, eocd + 12);
    assert.throws(() => parseProjectZipArchive(brokenDirectory), /central directory size mismatch/u);
});
