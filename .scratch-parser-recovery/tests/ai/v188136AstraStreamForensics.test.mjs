import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiResponseTrace } from '../../src/features/audit/aiResponseTrace.js';
import { consumeOpenAIStream } from '../../src/features/ai/openAIStream.js';
import { recoverTextResponseJobs, saveTextJobRecipient, markTextJobDelivered } from '../../src/features/audit/astraTextResponseRecovery.js';

async function scratch(fn) {
    const root = await mkdtemp(join(tmpdir(), 'gigorave-v188136-'));
    try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const createTrace = (root) => createAiResponseTrace({ root, jobId: randomUUID(), stage: 'whole-file',
    attempt: 1, logicalRequestId: 'test:whole-file', model: 'gpt-6-astra', api: 'responses', host: 'test.local' });

async function mockResponse({ chunks, type = 'text/event-stream', breakAfter = -1 }) {
    let index = 0;
    const response = new Response(new ReadableStream({
        pull(controller) {
            if (index === breakAfter) { controller.error(Object.assign(new Error('socket terminated'), {code:'ECONNRESET'})); return; }
            if (index >= chunks.length) { controller.close(); return; }
            controller.enqueue(chunks[index++]);
        },
    }), { headers: { 'content-type': type, 'cf-ray': 'ray-test' } });
    return response;
}

test('owner TXT HTTP trace preserves every delivered body byte including SSE heartbeat and fragmented UTF-8', async () => scratch(async (root) => {
    const trace = await createTrace(root);
    const raw = Buffer.from(': heartbeat\n\ndata: {"type":"response.output_text.delta","delta":"Привет 👋"}\n\ndata: [DONE]\n\n', 'utf8');
    const split = [raw.subarray(0, 17), raw.subarray(17, 51), raw.subarray(51, 67), raw.subarray(67)];
    let text = '', comments = 0, done = false;
    let response = await mockResponse({ chunks: split });
    await trace.receivedHeaders(response);
    response = trace.wrap(response);
    await consumeOpenAIStream(response, { onPayload: p => { text += p.delta || ''; },
        onComment: () => { comments++; }, onDone: () => { done = true; } });
    const outcome = await trace.finish('sse-completed', {completion:done});
    assert.deepEqual(await readFile(join(trace.directory, 'response.raw.bin')), raw);
    assert.equal(outcome.receivedBytes, raw.length);
    assert.equal(outcome.rawSha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(text, 'Привет 👋');
    assert.equal(comments, 1);
    assert.equal(done, true);
    const entries = (await readFile(join(trace.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.filter(e => e.event === 'body-chunk').length, 4);
    assert.equal(entries.find(e => e.event === 'http-headers')?.status, 200);
    assert.equal(entries.at(-1).event, 'request-finished');
    assert.equal(entries.find(e => e.event === 'body-chunk')?.offsetStart, 0);
    assert.equal(entries.filter(e=>e.event==='body-chunk').at(-1).offsetEnd, raw.length);
}));

test('owner TXT trace records actual read error and partial bytes, without calling another POST', async () => scratch(async (root) => {
    const trace = await createTrace(root);
    const first = Buffer.from(': heartbeat\n\ndata: {"type":"response.output_text.delta","delta":"часть"}\n\n');
    let response = await mockResponse({ chunks:[first], breakAfter:1 });
    await trace.receivedHeaders(response);
    response = trace.wrap(response);
    let failure;
    try { await consumeOpenAIStream(response); }
    catch (error) { failure = error; await trace.finish('stream-error', {error, responseId:'resp_test12345678901234'}); }
    assert.ok(failure);
    assert.deepEqual(await readFile(join(trace.directory, 'response.raw.bin')), first);
    const diagnosis = JSON.parse(await readFile(join(trace.directory, 'diagnosis.json')));
    assert.equal(diagnosis.completed, false);
    assert.equal(diagnosis.receivedBytes, first.length);
    assert.equal(diagnosis.responseId, 'resp_test12345678901234');
    const entries = (await readFile(join(trace.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(entries.some(e => e.event === 'body-read-error' && e.cause?.code === 'ECONNRESET'));
}));

test('trace includes HTTP error body (not just SSE) and records HTTP status', async () => scratch(async(root) => {
    const trace = await createTrace(root);
    const raw = Buffer.from('<html>Cloudflare 524 test</html>');
    let response = new Response(raw, {status:524, headers:{'content-type':'text/html','cf-ray':'test'}});
    await trace.receivedHeaders(response);
    response = trace.wrap(response);
    assert.equal((await response.text()), raw.toString());
    await trace.finish('http-error', {error:Object.assign(new Error('HTTP 524'), {status:524})});
    assert.deepEqual(await readFile(join(trace.directory,'response.raw.bin')),raw);
    const diagnosis = JSON.parse(await readFile(join(trace.directory,'diagnosis.json')));
    assert.equal(diagnosis.httpStatus,524);
}));

test('whole-file known responseId is recovered by GET and never reposted or delivered twice', async () => scratch(async(root) => {
    const jobId=randomUUID(), stage='whole-file', responseId='resp_123456789012345678901';
    await saveTextJobRecipient({root,jobId,chatId:'owner',filename:'audit.txt',model:'gpt-6-astra'});
    await mkdir(join(root,jobId,stage),{recursive:true});
    await writeFile(join(root,jobId,stage,'state.json'),JSON.stringify({status:'unknown',stage,responseId,startedAt:'2026-09-19T00:00:00.000Z'}));
    const fetched=[],delivered=[];
    const settings={root,ownerChatId:'owner',legacyResponseId:'',maxPolls:1,previousProcessCutoffMs:Date.now(),
        fetchResponse: async ({responseId:id})=>{fetched.push(id);return {status:'completed',output_text:'Целый ответ.'};},
        deliver: async data=>{delivered.push(data);return{telegramMessage:{message_id:321}};}};
    await recoverTextResponseJobs(settings);
    const saved=JSON.parse(await readFile(join(root,jobId,stage,'state.json')));
    assert.equal(saved.telegramMessageId,'321');
    assert.equal(saved.deliveryStatus,'delivered');
    assert.deepEqual(fetched,[responseId]);
    assert.equal(delivered[0].text,'Целый ответ.');
    assert.equal(delivered[0].stage,stage);
    await recoverTextResponseJobs(settings);
    assert.equal(fetched.length,1);
    assert.equal(delivered.length,1);
    assert.equal(await markTextJobDelivered({root,jobId,stage,telegramMessageId:321}),false); // already delivered
}));


test('startup refuses to redeliver a completed whole-file document with ambiguous Telegram delivery', async () => scratch(async(root) => {
    const jobId=randomUUID(), stage='whole-file', responseId='resp_9999999999999999999999';
    await saveTextJobRecipient({root,jobId,chatId:'owner',filename:'audit.txt',model:'gpt-6-astra'});
    await mkdir(join(root,jobId,stage),{recursive:true});
    const text='Отчёт полностью готов';
    await writeFile(join(root,jobId,stage,'answer.txt'),text);
    await writeFile(join(root,jobId,stage,'state.json'),JSON.stringify({status:'completed',stage,responseId,
        outputSha256:createHash('sha256').update(text).digest('hex'),startedAt:'2026-09-19T00:00:00.000Z'}));
    await writeFile(join(root,jobId,'delivery.json'),JSON.stringify({status:'sending-unknown'}));
    let sent=0,get=0;
    const events=[];
    await recoverTextResponseJobs({root,legacyResponseId:'',previousProcessCutoffMs:Date.now(),
        fetchResponse:async()=>{get++;return{status:'completed',output_text:text}},
        deliver:async()=>{sent++;return{message_id:42}},notify:async event=>events.push(event)});
    assert.equal(sent,0);
    assert.equal(get,0);
    assert.ok(events.some(event=>event.stage==='delivery-not-repeated'));
}));

test('disk /txt_status recognises completed whole-file stage after restart', async () => scratch(async(root) => {
    const previous=process.env.GIGORAVE_TEXT_DATA_DIR;
    process.env.GIGORAVE_TEXT_DATA_DIR=root;
    try {
        const { telegramTextJobStatus } = await import(`../../src/features/audit/telegramTextJobControl.js?v188136-status-${randomUUID()}`);
        const jobId=randomUUID();
        await mkdir(join(root,'astra-text-jobs',jobId,'whole-file'),{recursive:true});
        await writeFile(join(root,'astra-text-jobs',jobId,'whole-file','state.json'),
            JSON.stringify({status:'completed',stage:'whole-file',outputSha256:'sha',responseId:'resp_test'}));
        await mkdir(join(root,'telegram-text-transfer-logs',jobId),{recursive:true});
        await writeFile(join(root,'telegram-text-transfer-logs',jobId,'transfer.log'),
            '2026-09-20T00:00:00.000Z stage=whole-file-request-start totalBatches=1\n');
        const result=await telegramTextJobStatus(jobId);
        assert.equal(result.completed,1);
        assert.equal(result.total,1);
        assert.equal(result.unknown,0);
    } finally {
        if(previous===undefined) delete process.env.GIGORAVE_TEXT_DATA_DIR;
        else process.env.GIGORAVE_TEXT_DATA_DIR=previous;
    }
}));
