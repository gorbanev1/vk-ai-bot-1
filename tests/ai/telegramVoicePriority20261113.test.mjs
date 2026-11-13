import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transcribeTelegramVoiceInOrder} from '../../src/features/ai/telegramVoiceTranscriptionPriority.js';
const sample=model=>({text:'The students have already finished their homework.',model});
test('Gemini primary succeeds: exactly 1 Gemini attempt and no others',async()=>{
 const calls=[];
 const value=await transcribeTelegramVoiceInOrder({routerEnabled:true,localEnabled:true,
  routerTranscribe:async()=>{calls.push('gemini');return sample('gemini-3.8-flash')},
  localTranscribe:async()=>{calls.push('local');return sample('faster-whisper-small')},
  providerTranscribe:async()=>{calls.push('provider');return sample('gpt-transcribe')},
 });
 assert.equal(value.model,'gemini-3.8-flash');assert.deepEqual(calls,['gemini']);
});
test('Gemini fails once: exactly 1 local Whisper attempt succeeds',async()=>{
 const calls=[],fail=[];
 const value=await transcribeTelegramVoiceInOrder({routerEnabled:true,localEnabled:true,
  routerTranscribe:async()=>{calls.push('gemini');throw Error('timeout')},
  localTranscribe:async()=>{calls.push('whisper');return sample('faster-whisper-small')},
  providerTranscribe:async()=>{calls.push('provider');throw Error('not needed')},
  onStageFailure:(name)=>fail.push(name),
 });
 assert.equal(value.model,'faster-whisper-small');
 assert.deepEqual(calls,['gemini','whisper']);assert.deepEqual(fail,['router-gemini']);
});
test('Both primary recognizers fail: provider/model ladder executes once',async()=>{
 const calls=[],fail=[];
 const value=await transcribeTelegramVoiceInOrder({routerEnabled:true,localEnabled:true,
  routerTranscribe:async()=>{calls.push('gemini');throw Error('down')},
  localTranscribe:async()=>{calls.push('whisper');throw Error('down')},
  providerTranscribe:async()=>{calls.push('provider');return sample('gpt-transcribe')},
  onStageFailure:name=>fail.push(name),
 });
 assert.equal(value.model,'gpt-transcribe');assert.deepEqual(calls,['gemini','whisper','provider']);
 assert.deepEqual(fail,['router-gemini','local-whisper']);
});
test('Invalid Gemini words cause fallback, not hallucinated result',async()=>{
 const calls=[];
 const value=await transcribeTelegramVoiceInOrder({routerEnabled:true,localEnabled:true,
  routerTranscribe:async()=>{calls.push('gemini');return {text:'[NO_SPEECH]'}},
  localTranscribe:async()=>{calls.push('whisper');return sample('faster-whisper-small')},
  providerTranscribe:async()=>{throw Error('not needed')},
 });
 assert.equal(value.model,'faster-whisper-small');assert.deepEqual(calls,['gemini','whisper']);
});
test('No router key: Whisper first, then provider if needed',async()=>{
 const calls=[];
 const value=await transcribeTelegramVoiceInOrder({routerEnabled:false,localEnabled:true,
  routerTranscribe:async()=>{throw Error('not allowed')},
  localTranscribe:async()=>{calls.push('whisper');throw Error('offline')},
  providerTranscribe:async()=>{calls.push('provider');return sample('whisper-large-v3')},
 });
 assert.equal(value.model,'whisper-large-v3');assert.deepEqual(calls,['whisper','provider']);
});
test('When every STT stage fails, do not fabricate a transcript',async()=>{
 await assert.rejects(()=>transcribeTelegramVoiceInOrder({
  routerEnabled:true,localEnabled:true,
  routerTranscribe:async()=>{throw Error('timeout')},
  localTranscribe:async()=>{throw Error('failed')},
  providerTranscribe:async()=>{throw Error('No STT endpoint')},
 }),/No STT endpoint/);
});
test('app uses one Telegram STT order regardless of recipient; Gemini handles bilingual English Russian',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const router=readFileSync(new URL('../../src/features/ai/routerGeminiAudioTranscription.js',import.meta.url),'utf8');
 assert.match(app,/transcribeTelegramVoiceInOrder\(\{/u);
 assert.doesNotMatch(app,/const routerFirst=platform==='telegram'/u);
 assert.match(router,/Russian AND English/u);
 assert.match(router,/do not translate English to Russian or Russian to English/u);
});
