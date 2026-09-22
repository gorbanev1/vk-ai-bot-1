import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditStageJournal, auditStageInputHash } from '../../src/features/audit/projectAuditStageJournal.js';
import { executeRuntimeModelFailover, isTechnicalModelFailure } from '../../src/features/ai/modelProviderFailover.js';

const base = { jobId: 'AUDIT-UNIT', stage: 'batch-1', inputSha256: auditStageInputHash({model:'gpt-6-astra',systemPrompt:'sys',userPrompt:'user',maxTokens:8000}), inputChars: 7, model:'gpt-6-astra', inferenceIdempotencyKey:'test-idem' };
function fixture(fn) {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'audit-paid-stage-'));
  return Promise.resolve().then(() => fn(rootDirectory)).finally(() => rmSync(rootDirectory, { recursive:true, force:true }));
}

test('completed paid batch persists responseId, answer, events and returns same answer after restart', async () => fixture(async (rootDirectory) => {
  const journal = createAuditStageJournal({ ...base, rootDirectory });
  assert.equal(journal.read().status,'pending');
  journal.start();
  journal.responseCreated({ responseId:'resp_123', model:'gpt-6-astra', requestBaseUrl:'https://example.invalid/v1', credentialName:'provider-name' });
  journal.delta('{"findings":'); journal.delta('[]}');
  await journal.complete('{"findings":[]}', []);
  const saved = JSON.parse(readFileSync(journal.paths.statePath, 'utf8'));
  assert.equal(saved.status,'completed');
  assert.equal(saved.responseId,'resp_123');
  assert.equal(saved.providerCredentialName,'provider-name');
  assert.equal(saved.inputSha256,base.inputSha256);
  assert.deepEqual(saved.findings, []);
  assert.match(readFileSync(journal.paths.eventsPath,'utf8'), /output\.delta/u);
  const restarted = createAuditStageJournal({ ...base, rootDirectory });
  assert.equal(restarted.cachedAnswer(),'{"findings":[]}');
  assert.throws(() => restarted.start(), /REPOST_BLOCKED/u);
  assert.throws(() => createAuditStageJournal({ ...base, inputSha256:'different', rootDirectory }), /INPUT_MISMATCH/u);
  assert.doesNotMatch(readFileSync(journal.paths.statePath,'utf8'), /Bearer |api[_-]?key/iu);
}));

test('interrupted paid response retains responseId and never marks partial answer completed', async () => fixture(async (rootDirectory) => {
  const journal = createAuditStageJournal({ ...base, rootDirectory });
  journal.start(); journal.responseCreated({ responseId:'resp_known' }); journal.delta('partial');
  await journal.interrupt(Object.assign(new Error('socket closed'), {responseId:'resp_known'}));
  const restarted = createAuditStageJournal({ ...base, rootDirectory });
  assert.equal(restarted.read().responseId,'resp_known');
  assert.equal(restarted.read().status,'interrupted');
  assert.equal(restarted.cachedAnswer(),null);
  assert.throws(() => restarted.start(), /REPOST_BLOCKED/u);
  assert.equal(existsSync(journal.paths.answerPath),true);
}));

test('ambiguous stage without responseId is not silently replayed', async () => fixture(async (rootDirectory) => {
  const journal = createAuditStageJournal({ ...base, rootDirectory });
  journal.start(); await journal.interrupt(new Error('disconnect'));
  const restarted = createAuditStageJournal({ ...base, rootDirectory });
  assert.equal(restarted.read().status,'ambiguous');
  assert.throws(() => restarted.start(), /REPOST_BLOCKED/u);
}));

test('telemetry exceptions/rejections never turn success into a second provider request', async () => {
  const candidates = [ {provider:'compat',name:'first',baseUrl:'https://example.invalid/v1',secret:'x'}, {provider:'compat',name:'second',baseUrl:'https://example.invalid/v1',secret:'y'} ];
  for (const onEvent of [() => { throw new Error('telemetry failed'); }, () => Promise.reject(new Error('telemetry rejected'))]) {
    let attempts = 0;
    const result = await executeRuntimeModelFailover({ candidates, onEvent, maxRounds:1, useCredentialHealth:false, request: async () => { attempts++; return 'ok'; } });
    assert.equal(result.value,'ok'); assert.equal(attempts,1);
  }
});

test('paid response indicators prohibit generic key rotation and extra paid POST', async () => {
  const candidates = [ {provider:'compat',name:'first',baseUrl:'https://example.invalid/v1',secret:'x'}, {provider:'compat',name:'second',baseUrl:'https://example.invalid/v1',secret:'y'} ];
  for (const key of ['responseId','inferenceMayHaveStarted','streamOutputStarted','inferenceCompleted']) {
    const error = Object.assign(new Error('HTTP 524'), { [key]: key==='responseId'?'resp_paid':true });
    assert.equal(isTechnicalModelFailure(error),false);
    let attempts = 0;
    await assert.rejects(executeRuntimeModelFailover({candidates,maxRounds:1,useCredentialHealth:false,request:async()=>{attempts++;throw error;}}), /524/u);
    assert.equal(attempts,1, `${key} triggered repeated inference`);
  }
});
