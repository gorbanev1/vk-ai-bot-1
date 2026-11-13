import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildOfflineModelReport,getOfflineModelReport,isOfflineModelAllowed,formatOfflineModelReliability} from '../../src/features/ai/offlineModelReliability.js';
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
test('model 200 without correct text is NOT a success',()=>{
 const d=buildOfflineModelReport([{checkedAt:'2026-11-09T01:00:00Z',
 textResults:[{provider:'p',envName:'k',model:'correct',transports:{non_stream:{transport:'non_stream',status:200,ok:true,instructionCompliant:true,textSample:'GIGORAVE_AUDIT_OK'}}},{provider:'p',envName:'k',model:'bad',transports:{non_stream:{transport:'non_stream',status:200,ok:true,instructionCompliant:false,textSample:'hello'}}}],
 imageResults:[{provider:'p',envName:'k',model:'picture',transports:{non_stream:{transport:'non_stream',status:200,ok:true,imageBytes:999,mimeType:'image/png'}}},{provider:'p',envName:'k',model:'fake',transports:{non_stream:{transport:'non_stream',status:200,ok:true,imageBytes:0,mimeType:'text/plain'}}}]}],[],[{model:'GROQ_API_KEY_1:whisper-large-v3-turbo',status:'ok',transcript:'Здравствуйте',updated_at:1794180000}]);
 assert.equal(d.groups.text.find(x=>x.model==='correct').enabled,true);
 assert.equal(d.groups.text.find(x=>x.model==='bad').enabled,false);
 assert.equal(d.groups.image.find(x=>x.model==='picture').enabled,true);
 assert.equal(d.groups.image.find(x=>x.model==='fake').enabled,false);
 assert.equal(d.groups['audio-transcription'].find(x=>x.model==='whisper-large-v3-turbo').enabled,true);
 assert.equal(d.groups.text.some(x=>x.model==='whisper-large-v3-turbo'),false);
});
test('there is no scheduled automatic full model scan or synthetic probe, even on startup',()=>{
 for(const word of ['ai-model-discovery:startup','ai-model-discovery:tick','ai-channel-probe:hourly','image-generation-probe:four-hour','gpt6LunaHealthTimer'])assert.doesNotMatch(app,new RegExp(word));
 assert.match(app,/model-sweep-permanently-disabled-offline-ranking/u);
 assert.match(app,/formatOfflineModelReliability\(12\)/u);
 assert.match(app,/isOfflineModelAllowed\(\{provider:healthProvider,envName:credential.name,model,capability\}\)/u);
 const speech=readFileSync(new URL('../../src/features/ai/voiceTranscription.js',import.meta.url),'utf8');
 assert.match(speech,/capability:'audio-transcription'/u);
});
test('production offline historical report contains positive evidence by all modalities',()=>{
 const r=getOfflineModelReport();
 assert.ok(r&&r.scannedAudits>=1);
 assert.ok(r.groups.text.some(x=>x.enabled));
 assert.ok(r.groups.image.some(x=>x.enabled));
 assert.ok(r.groups.vision.some(x=>x.enabled&&x.model==='gpt-6-luna'));
 assert.ok(r.groups['audio-transcription'].some(x=>x.enabled));
 assert.match(formatOfflineModelReliability(1),/без новых запросов/u);
 assert.equal(isOfflineModelAllowed({provider:'unknown',envName:'key',model:'never-qualified',capability:'text'}),false);
});
