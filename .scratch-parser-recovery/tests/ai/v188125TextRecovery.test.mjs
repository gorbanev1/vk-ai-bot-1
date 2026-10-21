import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverTextResponseJobs, saveTextJobRecipient,
    LEGACY_TEXT_JOB_ID, LEGACY_TEXT_RESPONSE_ID } from '../../src/features/audit/astraTextResponseRecovery.js';

async function scratch(run) {
    const root = await mkdtemp(join(tmpdir(), 'gigorave-response-recovery-'));
    try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const writeState = async (root, jobId, state) => {
    const directory = join(root, jobId, 'full');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
};

test('legacy V188.124 responseId: startup uses GET only, sends complete TXT to owner and does not redeliver', async () => scratch(async (root) => {
    await writeState(root, LEGACY_TEXT_JOB_ID, { status: 'unknown', stage: 'full', responseId: LEGACY_TEXT_RESPONSE_ID });
    const requests = [], delivered = [];
    const options = { root, ownerChatId: 'owner-id', maxPolls: 2, wait: async () => {},
        fetchResponse: async ({ responseId }) => { requests.push(responseId); return {
            id: responseId, status: 'completed', output: [{content: [{type: 'output_text', text: 'Полный ответ по старому ID.'}]}],
        }; },
        deliver: async (doc) => { delivered.push(doc); return {message_id: 42}; },
    };
    const result = await recoverTextResponseJobs(options);
    assert.equal(result.length, 1);
    assert.deepEqual(requests, [LEGACY_TEXT_RESPONSE_ID]);
    assert.equal(delivered[0].chatId, 'owner-id');
    assert.equal(delivered[0].text, 'Полный ответ по старому ID.');
    assert.equal(delivered[0].responseId, LEGACY_TEXT_RESPONSE_ID);
    const state = JSON.parse(await readFile(join(root, LEGACY_TEXT_JOB_ID, 'full', 'state.json')));
    assert.equal(state.deliveryStatus, 'delivered');
    assert.equal(state.telegramMessageId, '42');
    await recoverTextResponseJobs(options);
    assert.equal(requests.length, 1);
    assert.equal(delivered.length, 1);
}));

test('unknown old stream with 404 preserves ID and reports GET unavailable, without inventing a report or POST', async () => scratch(async (root) => {
    await writeState(root, LEGACY_TEXT_JOB_ID, { status: 'unknown', responseId: LEGACY_TEXT_RESPONSE_ID });
    let calls = 0, deliveries = 0;
    const events = [];
    const opts = { root, ownerChatId: 'owner-id', maxPolls: 5,
        fetchResponse: async () => { calls++; throw Object.assign(new Error('GET unsupported'), {status: 404}); },
        deliver: async () => { deliveries++; }, notify: async (e) => { events.push(e); } };
    await recoverTextResponseJobs(opts);
    assert.equal(calls, 1);
    assert.equal(deliveries, 0);
    assert.ok(events.some((e) => e.stage === 'get-unavailable'));
    const state = JSON.parse(await readFile(join(root, LEGACY_TEXT_JOB_ID, 'full', 'state.json')));
    assert.equal(state.responseId, LEGACY_TEXT_RESPONSE_ID);
    assert.equal(state.recoveryStatus, 'unavailable');
    await recoverTextResponseJobs(opts);
    assert.equal(calls, 1);
}));

test('new TXT jobs persist recipient; do not deliver results of jobs without delivery metadata to owner', async () => scratch(async (root) => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    await saveTextJobRecipient({root, jobId:first, chatId:'owner-id', filename:'original.md', model:'gpt-5.6-terra'});
    await writeState(root, first, {status:'unknown', responseId:'resp_12345678901234567890'});
    await writeState(root, second, {status:'unknown', responseId:'resp_abcdefghijklmnopqrst'});
    const delivered=[];
    await recoverTextResponseJobs({root, ownerChatId:'owner-id', legacyResponseId:'', maxPolls:1,
        fetchResponse:async ({responseId}) => ({id:responseId,status:'completed',output_text:'Analysed'}),
        deliver:async (doc)=>{delivered.push(doc);return{message_id:10}},});
    assert.equal(delivered.length,1);
    assert.equal(delivered[0].jobId,first);
    assert.equal(delivered[0].filename,'original.md');
}));
