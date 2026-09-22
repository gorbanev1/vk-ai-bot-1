import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAstraTextStageWithRetry } from '../../src/features/audit/astraTextTransportRetry.js';
import { runAstraTextAttachmentAnalysis } from '../../src/features/audit/astraTextAttachment.js';

async function withRoot(fn) {
    const journalRoot = await mkdtemp(join(tmpdir(), 'gigorave-v188129-'));
    try { return await fn(journalRoot); }
    finally { await rm(journalRoot, { recursive: true, force: true }); }
}

const opts = { jobId: 'diagnostic-job', stage: 'part-0-5000', model: 'gpt-5.6-terra',
    reasoningEffort: 'high', prompt: 'text to analyze', systemPrompt: 'be precise',
    maxTokens: 8000, allowAmbiguousRepost: false };

test('long stream reaches model-returned, partial-flushed, completed in order and persists all deltas', async () => withRoot(async (journalRoot) => {
    const events = [];
    let posts = 0;
    const requestModel = async (options) => {
        posts++;
        await options.onBackgroundResponseCreated({ responseId: 'resp_test_complete_1234567890' });
        for (let n = 0; n < 15000; n++) options.onTextDelta('字', { streaming: true });
        return 'final answer';
    };
    const base = { ...opts, journalRoot, requestModel, onProgress: e => events.push(e) };
    assert.equal(await runAstraTextStageWithRetry(base), 'final answer');
    assert.equal(await runAstraTextStageWithRetry(base), 'final answer');
    assert.equal(posts, 1, 'completed stage must not POST again');
    const state = JSON.parse(await readFile(join(journalRoot, 'diagnostic-job/part-0-5000/state.json'), 'utf8'));
    assert.equal(state.status, 'completed');
    assert.equal(state.responseId, 'resp_test_complete_1234567890');
    assert.equal(state.partialChars, 15000);
    assert.equal(await readFile(join(journalRoot, 'diagnostic-job/part-0-5000/attempt-1.partial.txt'), 'utf8'), '字'.repeat(15000));
    assert.deepEqual(events.filter(e => ['request-model-returned', 'request-partial-flushed', 'retry-attempt-complete'].includes(e.stage)).map(e => e.stage),
        ['request-model-returned', 'request-partial-flushed', 'retry-attempt-complete']);
}));

test('journal flush preserves surrogate pairs split across SSE callbacks', async () => withRoot(async (journalRoot) => {
    const base = { ...opts, jobId: 'surrogate-job', journalRoot };
    const requestModel = async options => {
        options.onTextDelta('x'.repeat(8191) + '\uD83D', { streaming: true });
        options.onTextDelta('\uDE03' + 'end', { streaming: true });
        return 'complete';
    };
    await runAstraTextStageWithRetry({ ...base, requestModel });
    assert.equal(await readFile(join(journalRoot, 'surrogate-job/part-0-5000/attempt-1.partial.txt'), 'utf8'),
        'x'.repeat(8191) + '😃end');
}));

test('stream interruption after a delta keeps partial text, rejects a duplicate POST, and never reports completed', async () => withRoot(async (journalRoot) => {
    let posts = 0;
    let delivered = 0;
    const source = 'line foo\n'.repeat(32_000);
    const stages = [];
    const config = {
        descriptor: { filename: 'source.txt' }, requestText: 'review', jobId: 'interrupted-job',
        retryOptions: { journalRoot, allowAmbiguousRepost: false },
        download: async () => Buffer.from(source),
        requestModel: async options => {
            posts++;
            await options.onBackgroundResponseCreated({ responseId: 'resp_stream_interrupted_123456' });
            options.onTextDelta('partial answer before break', { streaming: true });
            const error = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET', inferenceMayHaveStarted: true });
            throw error;
        },
        onProgress: e => stages.push(e.stage),
        deliver: async () => { delivered++; },
    };
    await assert.rejects(runAstraTextAttachmentAnalysis(config), err => err.responseId === 'resp_stream_interrupted_123456' && err.streamOutputStarted);
    assert.equal(posts, 1);
    assert.equal(delivered, 0);
    const stage = 'part-0-72000';
    const state = JSON.parse(await readFile(join(journalRoot, 'interrupted-job', stage, 'state.json'), 'utf8'));
    assert.equal(state.status, 'unknown');
    assert.equal(state.partialChars, 'partial answer before break'.length);
    assert.equal(await readFile(join(journalRoot, 'interrupted-job', stage, 'attempt-1.partial.txt'), 'utf8'), 'partial answer before break');
    await assert.rejects(runAstraTextAttachmentAnalysis(config), /PREVIOUS_ATTEMPT_UNKNOWN/);
    assert.equal(posts, 1, 'restarted attempt may not start another paid inference');
    assert.ok(!stages.includes('part-complete'));
}));

test('adaptive subchunks update total and never emit progress with numerator above denominator', async () => withRoot(async (journalRoot) => {
    const source = 'a'.repeat(260_000);
    const events = [];
    let rejected = false;
    const completed = [];
    await runAstraTextAttachmentAnalysis({ descriptor: {filename:'source.txt'}, requestText: 'review',
        jobId: 'adaptive-job', retryOptions: { journalRoot }, download: async () => Buffer.from(source),
        requestModel: async options => {
            if (!rejected && options.userPrompt.includes('BEGIN TEXT PART')) {
                rejected = true;
                throw Object.assign(new Error('context window too large'), { status: 413 });
            }
            return 'part reviewed';
        },
        onProgress: e => { events.push(e); if (e.stage === 'part-complete') completed.push(e); },
        deliver: async () => {},
    });
    assert.ok(events.some(e => e.stage === 'chunk-replanned'));
    assert.ok(completed.every(e => e.batch <= e.totalBatches));
    assert.equal(completed.at(-1).batch, completed.at(-1).totalBatches);
    assert.equal(completed.at(-1).totalBatches, 5);
}));

test('Responses transport has a GET-only path for interrupted TXT with known response id', async () => {
    const source = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(source, /\(projectAuditStreaming \|\| textAttachmentStreaming\) && knownStreamResponseId/);
    assert.match(source, /payload = await pollOpenAIBackgroundResponse\(\{\s*responseId: knownStreamResponseId/s);
    assert.match(source, /ASTRA TEXT EXISTING RESPONSE RECOVERED/);
});
