
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createDateFreeParserPolicy} from '../../src/features/ai/dateFreeParserPolicy.js';
import {restrictParserModelLadder} from '../../src/features/ai/parserModelLadder.js';
const app=fs.readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
test('explicit parser fallback models survive a missing offline sample; chat remains gated',()=>{
 const start=app.indexOf('function buildRuntimeModelCandidates(');
 const end=app.indexOf('async function executeBotModelFailover(',start);
 const build=vm.runInNewContext(app.slice(start,end)+';buildRuntimeModelCandidates',{
 restrictParserModelLadder,runtimeModelCredentials:[{provider:'compat',name:'fixture',secret:'test',baseUrl:'https://invalid.example'}],
 resolveParserLadderRuntimeModelId:m=>m,normalizeRuntimeModelId:m=>m,modelAttemptLimit:()=>1,
 runtimeProviderHealthName:x=>x,isOfflineModelAllowed:()=>false
 });
 const models=['gpt-6-luna','gpt-5.6-luna','gpt-5.6-terra','gpt-6.1-sol','gpt-6-astra'];
 for(const capability of ['text','vision']){
 const ladder=models.map(model=>({model,attempts:1}));
 assert.deepEqual(Array.from(build({capability,modelLadder:ladder,useHealthFilter:false}),x=>x.model),models);
 assert.equal(build({capability,modelLadder:ladder,useHealthFilter:true}).length,0);
 }
});
test('paused phase retains concrete per-model failure evidence',async()=>{
 const p=createDateFreeParserPolicy();
 await assert.rejects(p.run('vision',async()=>{throw Object.assign(Error('upstream 502'),{code:'GPT_STREAM_ERROR'});}),{code:'DATE_FREE_PHASE_PAUSED'});
 for(const row of Object.values(p.snapshot().models)){
 assert.equal(row.lastError.code,'GPT_STREAM_ERROR');
 assert.equal(row.capabilities.vision.lastError.message,'upstream 502');
 }
});
