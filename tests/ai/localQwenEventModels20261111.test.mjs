import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildPublicEventTextExtractionPrompts} from '../../src/features/events/publicEventExtractionPrompts.js';
import {compareQwenEventCards,validateQwenEventJson,runLocalQwenEventModel,QWEN_EVENT_MODELS} from '../../src/features/events/localQwenEventModels.js';
test('the live event parser and local models use one identical prompt factory',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/\.\.\.buildPublicEventTextExtractionPrompts\(/u);
 assert.match(app,/startLocalQwenAnnouncementAudit/u);
 const p=buildPublicEventTextExtractionPrompts({post:{sourceUrl:'https://t.me/foo/2'},
  sourceText:'18 ноября концерт в клубе Этажи, начало в 20:00',confirmedPoster:false});
 assert.ok(p.systemPrompt.includes('structure_reason'));
 assert.ok(p.systemPrompt.includes('multiple_events'));
 assert.ok(p.userPrompt.includes('https://t.me/foo/2'));
 assert.ok(p.userPrompt.includes('Этажи'));
});
test('local Qwen respects original prompt and returns strict JSON metadata',async()=>{
 const fixture={structure:'single_event',structure_reason:'explicit date and place',
  events:[{title:'Концерт',date:'2026-11-18',time:'20:00',venue:'Этажи',participants:'',price:''}]};
 const result=await runLocalQwenEventModel({
  model:QWEN_EVENT_MODELS[0],systemPrompt:'Use exact parser prompt',userPrompt:'Post content',
  fetchImpl:async(url,init)=>{
   assert.equal(url,'http://127.0.0.1:11434/api/chat');
   const body=JSON.parse(init.body);
   assert.equal(body.format.type,'object');
   assert.ok(body.format.required.includes('events'));
   assert.equal(body.stream,false);
   assert.equal(body.messages[0].content,'Use exact parser prompt');
   assert.equal(body.messages[1].content,'Post content');
   return {ok:true,status:200,json:async()=>({message:{content:JSON.stringify(fixture)},eval_count:42})};
  }
 });
 assert.equal(result.model,'qwen3.5:4b');
 assert.deepEqual(result.parsed,fixture);
 const comparison=compareQwenEventCards([{id:1,title:'Концерт',event_date:'2026-11-18',
   time:'20:00',venue:'Этажи',participants:'',price:''}],result.parsed);
 assert.equal(comparison.fields.date.matches,1);
 assert.equal(comparison.fields.venue.matches,1);
 assert.equal(comparison.unmatchedCards,0);
});
test('missing or malformed JSON is rejected rather than accepted as an event',()=>{
 assert.throws(()=>validateQwenEventJson({structure:'single_event',structure_reason:'x',events:[]}),/count/);
 assert.throws(()=>validateQwenEventJson({events:[]}),/structure/);
});
