import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transcribeRouterGeminiAudio} from '../../src/features/ai/routerGeminiAudioTranscription.js';

const audio=Buffer.alloc(350,12);
test('verified router Gemini transcription accepts binary audio on native endpoint',async()=>{
 let called=false;
 const output=await transcribeRouterGeminiAudio({
  buffer:audio,mimeType:'audio/ogg; codecs=opus',apiKey:'dummy-test-key',
  fetchImpl:async(url,request)=>{
   called=true;
   assert.match(url,/\/v1beta\/models\/gemini-3\.8-flash:generateContent$/u);
   assert.equal(request.headers.Authorization,'Bearer dummy-test-key');
   const body=JSON.parse(request.body);
   assert.equal(body.contents[0].parts[1].inline_data.mime_type,'audio/ogg');
   assert.equal(Buffer.from(body.contents[0].parts[1].inline_data.data,'base64').length,audio.length);
   return {ok:true,status:200,json:async()=>({
    candidates:[{content:{parts:[{text:'Второй закон Ньютона'}]}}],
    usageMetadata:{promptTokenCount:111,candidatesTokenCount:14,totalTokenCount:125}
   })};
  }
 });
 assert.equal(called,true);assert.equal(output.text,'Второй закон Ньютона');
 assert.equal(output.model,'gemini-3.8-flash');
 assert.equal(output.usage.total_tokens,125);
});
test('router invalid or empty responses are failures, not successful transcripts',async()=>{
 for(const response of [
  {ok:false,status:503,json:async()=>({error:{code:'unavailable',message:'overloaded'}})},
  {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[]}}]})}
 ]){
  await assert.rejects(()=>transcribeRouterGeminiAudio({
   buffer:audio,apiKey:'dummy',fetchImpl:async()=>response
  }),/Router Gemini audio/u);
 }
});
test('all Telegram voice messages use the existing Gemini-first and local Whisper fallback',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const start=app.indexOf('const response=await transcribeTelegramVoiceInOrder({');
 const end=app.indexOf('const transcript = normalizeVoiceTranscript(response.text);',start);
 assert.ok(start>=0&&end>start);
 const block=app.slice(start,end);
 assert.match(block,/routerEnabled:Boolean\(String\(process\.env\.OPENAI_COMPAT_API_KEY/);
 assert.match(block,/localEnabled:localVoiceTranscriptionEnabled/);
 assert.match(block,/routerTranscribe:/);
 assert.match(block,/localTranscribe:/);
 assert.match(block,/providerTranscribe:/);
 assert.doesNotMatch(block,/milanaRecipient|routerFirst|OPENAI_COMPAT_API_KEY_2/);
});
