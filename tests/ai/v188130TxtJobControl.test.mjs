import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAstraTextStageWithRetry } from '../../src/features/audit/astraTextTransportRetry.js';
import { beginTelegramTextJob, observeTelegramTextJob, finishTelegramTextJob,
    saveTelegramTextJobInput, loadTelegramTextJobInput, getTelegramTextJobDeliveryState,
    markTelegramTextJobDelivery } from '../../src/features/audit/telegramTextJobControl.js';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
async function temp(fn) { const root = await mkdtemp(join(tmpdir(), 'gigorave-txt-control-')); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
const modelArgs = { model: 'gpt-5.6-terra', reasoningEffort: 'high', systemPrompt: 'system', prompt: 'prompt', maxTokens: 8000 };
const stage = 'part-0-72000';

test('2m silence warns, real bytes resume; three-hour byte silence DOES NOT locally abort TXT', async () => {
    const messages = [];
    const job = beginTelegramTextJob({ jobId: randomUUID(), send: async msg => { messages.push(msg); } });
    try {
        await observeTelegramTextJob(job, { stage: 'chunk-plan', totalBatches: 29 });
        await observeTelegramTextJob(job, { stage: 'retry-attempt-start' });
        await observeTelegramTextJob(job, { stage: 'request-waiting', elapsedSec: 121, streamBytesReceived: 0 });
        assert.equal(messages.filter(m => m.includes('возможно, поток простаивает')).length, 1);
        await observeTelegramTextJob(job, { stage: 'network-bytes-received', streamBytesReceived: 512 });
        assert.ok(messages.some(m => m.includes('сервер снова присылает данные')));
        assert.equal(job.controller.signal.aborted, false);
        await observeTelegramTextJob(job, { stage: 'request-waiting', elapsedSec: 10_801,
            secondsSinceNetworkByte: 10_801, streamBytesReceived: 512 });
        assert.equal(job.controller.signal.aborted, false);
        assert.ok(messages.some(m => m.includes('возможно, поток простаивает')));
    } finally { await finishTelegramTextJob(job, new Error('test idle')); }
});

test('exact local completed model answer survives crash before final stage checkpoint, no new POST', async () => temp(async root => {
    const jobId = randomUUID(); const dir = join(root, jobId, stage);
    await mkdir(dir, { recursive: true });
    const answer = 'Provider completed the answer.';
    const inputSha256 = sha(`${modelArgs.model}\n${modelArgs.reasoningEffort}\n${modelArgs.systemPrompt}\n${modelArgs.prompt}`);
    await writeFile(join(dir, 'answer.txt'), answer);
    await writeFile(join(dir, 'state.json'), JSON.stringify({ status: 'model-returned', inputSha256,
        outputSha256: sha(answer), responseId: '' }));
    let posts = 0;
    const result = await runAstraTextStageWithRetry({ ...modelArgs, jobId, stage, journalRoot: root,
        requestModel: async () => { posts++; throw new Error('UNEXPECTED_PAID_POST'); } });
    assert.equal(result, answer); assert.equal(posts, 0);
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).status, 'completed');
}));

test('same responseId GET can complete an unknown stage, without any replacement POST', async () => temp(async root => {
    const jobId = randomUUID(); const dir = join(root, jobId, stage);
    await mkdir(dir, { recursive: true });
    const inputSha256 = sha(`${modelArgs.model}\n${modelArgs.reasoningEffort}\n${modelArgs.systemPrompt}\n${modelArgs.prompt}`);
    const responseId = 'resp_mock_retrievable_123456789';
    await writeFile(join(dir, 'state.json'), JSON.stringify({ status: 'unknown', inputSha256, responseId }));
    let posts = 0; let gets = 0;
    const result = await runAstraTextStageWithRetry({ ...modelArgs, jobId, stage, journalRoot: root,
        requestModel: async () => { posts++; throw new Error('UNEXPECTED_PAID_POST'); },
        recoverResponse: async r => { assert.equal(r.responseId, responseId); gets++; return 'Original completed response'; } });
    assert.equal(result, 'Original completed response'); assert.equal(gets, 1); assert.equal(posts, 0);
}));

test('unknown stage with no retrievable ID cannot be restarted even when operator requests resume', async () => temp(async root => {
    const jobId = randomUUID(); const dir = join(root, jobId, stage);
    await mkdir(dir, { recursive: true });
    const inputSha256 = sha(`${modelArgs.model}\n${modelArgs.reasoningEffort}\n${modelArgs.systemPrompt}\n${modelArgs.prompt}`);
    await writeFile(join(dir, 'state.json'), JSON.stringify({ status: 'unknown', inputSha256, responseId: '' }));
    let posts = 0;
    await assert.rejects(runAstraTextStageWithRetry({ ...modelArgs, jobId, stage, journalRoot: root,
        requestModel: async () => { posts++; return 'duplicated inference'; },
        recoverResponse: async () => { throw new Error('must not GET without ID'); } }), /PREVIOUS_ATTEMPT_UNKNOWN/u);
    assert.equal(posts, 0);
}));

test('input checkpoint is immutable; a corrupted source cannot be used to resume a paid job', async () => temp(async root => {
    const jobId = randomUUID(); const opts = { root, jobId, text: 'Original document',
        requestText: 'audit', model: 'gpt-5.6-terra', reasoningEffort: 'high', filename: 'test.txt' };
    await saveTelegramTextJobInput(opts);
    assert.equal((await loadTelegramTextJobInput(jobId, {root})).text, 'Original document');
    await assert.rejects(saveTelegramTextJobInput({ ...opts, text: 'Changed document' }), /INPUT_MISMATCH/u);
    await writeFile(join(root, jobId, 'source.txt'), 'Corrupted document');
    await assert.rejects(loadTelegramTextJobInput(jobId, {root}), /INPUT_HASH_MISMATCH/u);
}));

test('Telegram final delivery is tracked separately to prevent accidental duplicate send on resume', async () => temp(async root => {
    const jobId = randomUUID(); await mkdir(join(root, jobId), {recursive:true});
    await markTelegramTextJobDelivery({root, jobId, status:'sending-unknown', filename:'final.txt'});
    await assert.rejects(markTelegramTextJobDelivery({root, jobId, status:'sending-unknown', filename:'final.txt'}), /PREVIOUS_SEND_UNKNOWN/u);
    await markTelegramTextJobDelivery({root, jobId, status:'accepted', filename:'final.txt', telegramMessageId:'43'});
    assert.equal((await getTelegramTextJobDeliveryState(jobId, {root})).status, 'accepted');
}));

test('resume continues only not-yet-started text parts; completed parts are reused without another POST', async () => temp(async root => {
    const { runAstraTextAttachmentAnalysis } = await import('../../src/features/audit/astraTextAttachment.js');
    const jobId = randomUUID();
    const source = 'Line of the original source.\n'.repeat(11_000);
    const posts = [];
    const seen = new Set();
    const args = {
        descriptor: {filename:'source.txt'}, jobId, model:'gpt-5.6-terra', reasoningEffort:'high',
        requestText:'Audit exact same source', download:async()=>Buffer.from(source,'utf8'),
        retryOptions:{journalRoot:root,allowAmbiguousRepost:false},
        requestModel:async options=>{
            const m=options.userPrompt.match(/диапазон символов: (\d+)–(\d+)/u);
            if(m) { const key=`${m[1]}-${m[2]}`; posts.push(key); assert.ok(!seen.has(key),`double paid part ${key}`); seen.add(key); }
            return 'Completed model response for this part';
        },
        deliver:async()=>{},
    };
    let attemptedParts=0;
    await assert.rejects(runAstraTextAttachmentAnalysis({...args,onProgress:async e=>{
        if(e.stage==='part-start' && ++attemptedParts===3) throw new Error('test process stopped before third request');
    }}),/test process stopped before third request/u);
    assert.equal(posts.length,2,'first run paid only two parts');
    const result=await runAstraTextAttachmentAnalysis({...args,onProgress:async()=>{}});
    assert.equal(result.batches,seen.size);
    assert.equal(posts.length,seen.size,'recovery must not re-POST completed chunks');
    assert.ok(seen.size>=4);
}));

test('real SSE heartbeat does not falsely count as model text: owner sees text-idle and text-resumed separately', async () => {
    const messages = [];
    const job = beginTelegramTextJob({ jobId: randomUUID(), send: async message => messages.push(message) });
    try {
        await observeTelegramTextJob(job, { stage: 'chunk-plan', totalBatches: 29 });
        await observeTelegramTextJob(job, { stage: 'retry-attempt-start' });
        await observeTelegramTextJob(job, { stage: 'network-bytes-received', streamBytesReceived: 2048 });
        await observeTelegramTextJob(job, { stage: 'request-waiting', elapsedSec: 130,
            secondsSinceNetworkByte: 1, secondsSinceText: null, streamBytesReceived: 2048 });
        assert.equal(job.controller.signal.aborted, false);
        assert.equal(messages.filter(message => message.includes('сеть получает данные, но нового текста')).length, 1);
        assert.equal(messages.filter(message => message.includes('возможно, поток простаивает')).length, 0);
        await observeTelegramTextJob(job, { stage: 'request-waiting', elapsedSec: 155,
            secondsSinceNetworkByte: 1, secondsSinceText: 1, streamBytesReceived: 4096 });
        assert.ok(messages.some(message => message.includes('модель снова присылает текст')));
        assert.equal(job.controller.signal.aborted, false);
    } finally { await finishTelegramTextJob(job); }
});
