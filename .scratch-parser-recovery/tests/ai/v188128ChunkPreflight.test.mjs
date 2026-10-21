import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAstraTextAttachmentAnalysis, ASTRA_TEXT_ATTACHMENT_BATCH_CHARS } from '../../src/features/audit/astraTextAttachment.js';

async function withJournal(fn) {
    const journalRoot = await mkdtemp(join(tmpdir(), 'gigorave-v188128-'));
    try { await fn(journalRoot); } finally { await rm(journalRoot, {recursive:true, force:true}); }
}

test('provider context_length_exceeded with status=null and pessimistic started marker falls back to chunks', async () => withJournal(async (journalRoot) => {
    const source = 'function abc() {}\n'.repeat(11_000); // below preflight threshold
    let count = 0;
    const delivered = [];
    await runAstraTextAttachmentAnalysis({
        descriptor: { filename: 'source.txt' }, requestText: 'Проверь код',
        jobId: 'explicit-refusal-job', retryOptions: { journalRoot },
        download: async () => Buffer.from(source),
        requestModel: async (options) => {
            count++;
            if (count === 1) {
                const error = new Error("GPT STREAM ERROR context_length_exceeded: This model's maximum context length is 372000 tokens, but the request requires 484612 estimated input tokens plus up to 20000 output tokens.");
                error.inferenceMayHaveStarted = true; error.status = null;
                throw error;
            }
            assert.ok(options.userPrompt.includes('BEGIN TEXT PART') || options.userPrompt.includes('результаты анализа'));
            return 'Часть проверена';
        },
        deliver: (result) => delivered.push(result),
    });
    assert.ok(count > 2);
    assert.equal(delivered.length, 1);
    const full = JSON.parse(await readFile(join(journalRoot, 'explicit-refusal-job', 'full', 'state.json'), 'utf8'));
    assert.equal(full.status, 'failed');
    assert.equal(full.outcome, 'rejected');
}));

test('known responseId during chunk error stops processing without a second POST or fabricated TXT', async () => withJournal(async (journalRoot) => {
    const source = 'test line\n'.repeat(30_000); // above preflight threshold
    let calls = 0; let deliveries = 0;
    await assert.rejects(runAstraTextAttachmentAnalysis({
        descriptor: { filename:'source.txt' }, requestText:'Проверь код',
        jobId: 'known-response-chunk', retryOptions: { journalRoot, allowAmbiguousRepost: false },
        download: async () => Buffer.from(source),
        requestModel: async (opts) => {
            calls++;
            await opts.onBackgroundResponseCreated({ responseId:'resp_protected' });
            throw Object.assign(new Error('GPT RESPONSES STREAM ERROR: stream_read_error'),
                { code:'MODEL_STREAM_FAILED', inferenceMayHaveStarted:true });
        },
        deliver: () => { deliveries++; },
    }), (err) => err.responseId === 'resp_protected');
    assert.equal(calls, 1);
    assert.equal(deliveries, 0);
    const state = JSON.parse(await readFile(join(journalRoot, 'known-response-chunk', `part-0-${ASTRA_TEXT_ATTACHMENT_BATCH_CHARS}`, 'state.json'), 'utf8'));
    assert.equal(state.status, 'unknown');
    assert.equal(state.responseId, 'resp_protected');
}));

test('proactive chunk mode preserves independent Sol max selection and one assembled TXT', async () => withJournal(async (journalRoot) => {
    const source = 'const value = 1;\n'.repeat(16_000);
    const delivered = [];
    let count = 0;
    const result = await runAstraTextAttachmentAnalysis({
        descriptor: {filename:'source.txt'}, requestText:'Проверь код',
        model:'gpt-5.6-sol', reasoningEffort:'max', jobId:'sol-max-chunk',
        retryOptions: { journalRoot }, download: async () => Buffer.from(source),
        requestModel: async (opts) => {
            count++;
            assert.equal(opts.reasoningEffort,'max');
            assert.equal(opts.backgroundResponse, false);
            assert.equal(opts.inputFiles.length, 0);
            assert.ok(opts.userPrompt.length < ASTRA_TEXT_ATTACHMENT_BATCH_CHARS + 2000);
            return 'Анализ';
        },
        deliver: (result) => { delivered.push(result); },
    });
    assert.ok(count > 1);
    assert.ok(result.batches > 1);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].buffer.toString('utf8'), /ПОДРОБНЫЕ РЕЗУЛЬТАТЫ/u);
}));
