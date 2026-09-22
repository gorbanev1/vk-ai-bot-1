import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAstraTextStageWithRetry, isRetryableAstraTextTransportError } from '../../src/features/audit/astraTextTransportRetry.js';
import { runAstraTextAttachmentAnalysis } from '../../src/features/audit/astraTextAttachment.js';

async function withDir(run) {
    const root = await mkdtemp(join(tmpdir(), 'gigorave-astra-retry-'));
    try { await run(root); } finally { await rm(root, { force: true, recursive: true }); }
}
const base = { stage: 'full', jobId: 'unit-job', prompt: 'source', systemPrompt: 'rules', maxTokens: 200,
    wait: async () => {}, maxAttempts: 3, allowAmbiguousRepost: true };
const networkError = () => Object.assign(new Error('GPT RESPONSES STREAM ERROR: stream_read_error'),
    { code: 'MODEL_STREAM_FAILED', inferenceMayHaveStarted: true, streamOutputStarted: true });

test('at most three sequential ambiguous attempts reuse same idempotency key and persist partial output', async () => withDir(async (journalRoot) => {
    const keys = [];
    const events = [];
    const result = await runAstraTextStageWithRetry({ ...base, journalRoot,
        onProgress: (e) => events.push(e),
        requestModel: async (opts) => {
            keys.push(opts.inferenceIdempotencyKey);
            assert.equal(opts.streamOverride, true);
            assert.equal(opts.disableTransportFallback, true);
            assert.equal(opts.disableProviderRetry, true);
            opts.onTextDelta?.('not complete', { streaming: true });
            if (keys.length < 3) throw networkError();
            return 'complete';
        },
    });
    assert.equal(result, 'complete');
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 1);
    assert.equal(keys[0], 'astra-text:unit-job:full');
    const s = JSON.parse(await readFile(join(journalRoot, 'unit-job/full/state.json'), 'utf8'));
    assert.equal(s.status, 'completed');
    assert.ok(events.some((e) => e.stage === 'retry-scheduled' && e.possibleDuplicateInference));
    assert.equal(await readFile(join(journalRoot, 'unit-job/full/attempt-1.partial.txt'), 'utf8'), 'not complete');
}));

test('responseId blocks every new paid POST even when the stream fails', async () => withDir(async (journalRoot) => {
    let calls = 0;
    await assert.rejects(runAstraTextStageWithRetry({ ...base, journalRoot, requestModel: async (opts) => {
        calls++;
        await opts.onBackgroundResponseCreated({ responseId: 'resp_existing' });
        throw networkError();
    }}), (err) => err.responseId === 'resp_existing');
    assert.equal(calls, 1);
    const s = JSON.parse(await readFile(join(journalRoot, 'unit-job/full/state.json'), 'utf8'));
    assert.equal(s.status, 'unknown');
    assert.equal(s.responseId, 'resp_existing');
    await assert.rejects(runAstraTextStageWithRetry({ ...base, journalRoot, requestModel: async () => { calls++; return 'bad'; } }),
        /PREVIOUS_ATTEMPT_UNKNOWN/);
    assert.equal(calls, 1);
}));

test('completed stage reused without another POST; altered prompt rejected', async () => withDir(async (journalRoot) => {
    let calls = 0;
    const requestModel = async () => { calls++; return 'persisted text'; };
    const opts = { ...base, journalRoot, requestModel };
    assert.equal(await runAstraTextStageWithRetry(opts), 'persisted text');
    assert.equal(await runAstraTextStageWithRetry(opts), 'persisted text');
    assert.equal(calls, 1);
    await assert.rejects(runAstraTextStageWithRetry({ ...opts, prompt: 'different input' }), /INPUT_CHANGED/);
}));

test('non-retryable input/auth errors do not POST again', async () => withDir(async (journalRoot) => {
    let calls = 0;
    await assert.rejects(runAstraTextStageWithRetry({ ...base, journalRoot,
        requestModel: async () => { calls++; throw Object.assign(new Error('bad request'), { status: 400 }); },
    }), /bad request/);
    assert.equal(calls, 1);
    assert.equal(isRetryableAstraTextTransportError({ status: 413 }), false);
    assert.equal(isRetryableAstraTextTransportError({ status: 429 }), true);
}));

test('whole-file 413 takes part route, but stream_read_error does not silently split', async () => withDir(async (journalRoot) => {
    let calls = 0;
    const delivered = [];
    const fullRejection = Object.assign(new Error('payload too large'), { status: 413, inferenceMayHaveStarted: false });
    const source = 'line alpha\n'.repeat(8000);
    const result = await runAstraTextAttachmentAnalysis({
        descriptor: { filename: 'source.txt' }, requestText: 'astra max analyze',
        download: async () => Buffer.from(source), deliver: (item) => delivered.push(item),
        retryOptions: { journalRoot, wait: async () => {} },
        requestModel: async (opts) => { calls++; if (calls === 1) throw fullRejection; return 'part analyzed'; },
    });
    assert.ok(result.batches > 1);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].buffer.toString(), /ПОДРОБНЫЕ РЕЗУЛЬТАТЫ/);
}));
