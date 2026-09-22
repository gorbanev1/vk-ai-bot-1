import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveTextAttachmentModelChoice } from '../../src/features/audit/textAttachmentModelSelection.js';
import { runAstraTextAttachmentAnalysis } from '../../src/features/audit/astraTextAttachment.js';
import { saveTelegramTextJobInput, loadTelegramTextJobInput } from '../../src/features/audit/telegramTextJobControl.js';

async function inJournal(run) {
    const root = await mkdtemp(join(tmpdir(), 'gigorave-txt-full-'));
    try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

for (const [prefix, mode, effort] of [
    ['Гигорейв astra max', 'astra', 'max'],
    ['Гигорейв terra high', 'pro2', 'high'],
    ['Гигорейв sol xhigh', 'pro3', 'xhigh'],
    ['Гигорейв gpt-5.5 high', 'gpt55', 'high'],
    ['Гигорейв mini low', 'default', 'low'],
    ['Гигорейв luna medium', 'pro', 'medium'],
]) {
    test(`/txt_full with ${prefix} retains selected model and effort`, () => {
        const chosen = resolveTextAttachmentModelChoice(`${prefix} /txt_full Аудит всего файла`);
        assert.equal(chosen.mode, mode);
        assert.equal(chosen.reasoningEffort, effort);
        assert.equal(chosen.wholeFile, true);
        assert.equal(chosen.prompt, 'Аудит всего файла');
    });
}

test('ordinary TXT keeps existing batching by default', () => {
    const chosen = resolveTextAttachmentModelChoice('Гигорейв astra max Аудит файла');
    assert.equal(chosen.wholeFile, false);
});

test('775506-character TXT in full mode is supplied entirely to exactly one model POST and one TXT delivery', async () => inJournal(async (journalRoot) => {
    const content = ('[VK CODE]\nconst fullDom = true;\n').repeat(25_000) + 'END_OF_SOURCE_MARKER';
    assert.ok(content.length > 775_506);
    const events = [], requests = [], delivered = [];
    const result = await runAstraTextAttachmentAnalysis({
        descriptor: { filename: 'vk-source.txt' }, requestText: 'Выполни сквозной аудит',
        wholeFile: true, model: 'gpt-6-astra', reasoningEffort: 'max', jobId: randomUUID(),
        retryOptions: { journalRoot, maxAttempts: 1 },
        download: async () => Buffer.from(content, 'utf8'),
        requestModel: async opts => { requests.push(opts); return 'Полный аудит VK'; },
        onProgress: async event => events.push(event),
        deliver: async document => delivered.push(document),
    });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].userPrompt.includes(content));
    assert.ok(requests[0].userPrompt.includes('END_OF_SOURCE_MARKER'));
    assert.equal(requests[0].reasoningEffort, 'max');
    assert.equal(requests[0].streamOverride, true);
    assert.equal(result.batches, 0);
    assert.equal(result.modelCalls, 1);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].buffer.toString('utf8'), /Полный аудит VK/u);
    assert.ok(events.some(e => e.stage === 'whole-file-request-start' && e.totalBatches === 1));
    assert.ok(!events.some(e => e.stage === 'chunk-plan' || e.stage === 'part-start'));
}));

test('provider context rejection in /txt_full never splits and never sends a second POST', async () => inJournal(async journalRoot => {
    const content = 'source\n'.repeat(40_000);
    let requests = 0, deliveries = 0;
    await assert.rejects(runAstraTextAttachmentAnalysis({
        descriptor: { filename: 'vk-source.txt' }, requestText: 'Аудит', wholeFile: true,
        jobId: randomUUID(), retryOptions: { journalRoot, maxAttempts: 1 },
        download: async () => Buffer.from(content),
        requestModel: async () => { requests++; throw Object.assign(new Error('context length exceeded'), { status: 400 }); },
        deliver: async () => { deliveries++; },
    }), error => error.code === 'TXT_FULL_CONTEXT_REJECTED');
    assert.equal(requests, 1);
    assert.equal(deliveries, 0);
}));

test('/txt_full disables all automatic retries even if an otherwise retryable HTTP failure happens before model output', async () => inJournal(async journalRoot => {
    let requests = 0;
    await assert.rejects(runAstraTextAttachmentAnalysis({
        descriptor: { filename: 'vk.txt' }, requestText: 'Аудит', wholeFile: true,
        jobId: randomUUID(), retryOptions: { journalRoot, maxAttempts: 3, allowAmbiguousRepost: true },
        download: async () => Buffer.from('source'.repeat(50_000)),
        requestModel: async () => { requests++; throw Object.assign(new Error('HTTP 503'), { status: 503 }); },
        deliver: async () => assert.fail('No fabricated TXT'),
    }), /HTTP 503/u);
    assert.equal(requests, 1);
}));

test('ambiguous /txt_full error with a response ID is never retried, chunked or falsely delivered', async () => inJournal(async journalRoot => {
    const content = 'code\n'.repeat(60_000);
    const jobId = randomUUID();
    let requests = 0, delivered = 0;
    const args = {
        descriptor: { filename: 'vk-source.txt' }, requestText: 'Аудит', wholeFile: true,
        jobId, retryOptions: { journalRoot, maxAttempts: 3, allowAmbiguousRepost: false },
        download: async () => Buffer.from(content),
        requestModel: async opts => {
            requests++;
            await opts.onBackgroundResponseCreated({ responseId: 'resp_known' });
            throw Object.assign(new Error('stream broken'), { code: 'MODEL_STREAM_FAILED', inferenceMayHaveStarted: true });
        },
        deliver: async () => { delivered++; },
    };
    await assert.rejects(runAstraTextAttachmentAnalysis(args), e => e.responseId === 'resp_known');
    assert.equal(requests, 1);
    assert.equal(delivered, 0);
    const state = JSON.parse(await readFile(join(journalRoot, jobId, 'whole-file', 'state.json'), 'utf8'));
    assert.equal(state.status, 'unknown');
    assert.equal(state.responseId, 'resp_known');
    await assert.rejects(runAstraTextAttachmentAnalysis(args), /PREVIOUS_ATTEMPT_UNKNOWN/u);
    assert.equal(requests, 1);
}));

test('source checkpoint persists /txt_full flag and rejects changing mode on resume', async () => inJournal(async root => {
    const jobId = randomUUID();
    const input = { jobId, text: 'source', requestText: 'Аудит', model: 'gpt-5.6-sol', reasoningEffort: 'high', filename: 'vk.txt', root };
    await saveTelegramTextJobInput({ ...input, wholeFile: true });
    assert.equal((await loadTelegramTextJobInput(jobId, { root })).wholeFile, true);
    await saveTelegramTextJobInput({ ...input, wholeFile: true });
    await assert.rejects(saveTelegramTextJobInput({ ...input, wholeFile: false }), /INPUT_MISMATCH/u);
}));

test('Telegram intake and resume pass the full-file flag to the same TXT stage and never ZIP', () => {
    const code = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = code.indexOf('async function executeTelegramTextJob(');
    const end = code.indexOf('async function maybeHandleProjectArchiveAuditIncoming(', start);
    const route = code.slice(start, end);
    assert.match(route, /wholeFile: selection[.]wholeFile/u);
    assert.match(route, /wholeFile: Boolean\(input[.]wholeFile\)/u);
    assert.match(route, /jobId, model, reasoningEffort, wholeFile/u);
    assert.match(route, /requestText: exactTask, model, reasoningEffort, wholeFile/u);
});
