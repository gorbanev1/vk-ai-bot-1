import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildPublicEventTextExtractionPrompts} from '../../src/features/events/publicEventExtractionPrompts.js';
import {QWEN_MODEL_TIMEOUT_MS,QWEN_MODEL_CPU_THREADS,QWEN_EVENT_MODELS,
 runLocalQwenEventModel} from '../../src/features/events/localQwenEventModels.js';
import {initializeFutureQwenCardAudit,processFutureQwenCards}
 from '../../src/features/events/futureQwenEventAudit.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'qwen-future-card-'));
 mkdirSync(join(root,'data'),{recursive:true});
 const db=new DatabaseSync(join(root,'data','bot.sqlite'));
 for(const table of ['vk_events','telegram_events','vk_chat_events','manual_events']){
  db.exec('CREATE TABLE '+table+'(id INTEGER PRIMARY KEY,screen_name TEXT,post_id INTEGER,'+
   'channel TEXT,message_id INTEGER,peer_id INTEGER,conversation_message_id INTEGER,'+
   'title TEXT,event_date TEXT,event_time TEXT,venue TEXT,participants TEXT,'+
   'price TEXT,description TEXT,evidence TEXT,source_url TEXT,source_text TEXT,'+
   'source_segment_text TEXT,structure_decision TEXT,status TEXT,event_tags_json TEXT)');
 }
 for(const table of ['vk_source_posts','telegram_source_posts','vk_chat_source_messages']){
  db.exec('CREATE TABLE '+table+'(screen_name TEXT,post_id INTEGER,channel TEXT,'+
   'message_id INTEGER,peer_id INTEGER,conversation_message_id INTEGER,'+
   'raw_text TEXT,source_url TEXT,published_at INTEGER,created_at INTEGER,'+
   'parse_status TEXT,image_vision_facts_json TEXT)');
 }
 db.exec('CREATE TABLE event_dedupe_archive(source_type TEXT,event_id INTEGER,event_row_json TEXT)');
 db.prepare('INSERT INTO telegram_source_posts(channel,message_id,raw_text,source_url,published_at,parse_status)'+
  ' VALUES(?,?,?,?,?,?)').run('old',1,'Old club post','https://t.me/old/1',1700000000,'event');
 db.prepare('INSERT INTO telegram_events(id,channel,message_id,title,event_date,venue)'+
  ' VALUES(?,?,?,?,?,?)').run(1,'old',1,'Old event','2026-11-19','Old club');
 return {root,db};
}
const response={structure:'single_event',structure_reason:'date and venue named',
 events:[{title:'New event',date:'2026-11-20',time:'20:00',venue:'Club',
  participants:'',price:'',announcement:'',evidence:'',tags:[]}]};
function stub(counter){
 return async(url,init)=>{
  if(url.endsWith('/api/tags'))
   return {ok:true,json:async()=>({models:QWEN_EVENT_MODELS.map(name=>({name}))})};
  assert.ok(url.endsWith('/api/chat'));
  const request=JSON.parse(init.body);
  counter.push(request);
  assert.equal(request.options.num_thread,QWEN_MODEL_CPU_THREADS);
  assert.ok(request.options.num_ctx>=12288);
  return {ok:true,status:200,json:async()=>({
   message:{content:JSON.stringify(response)},done_reason:'stop',
   eval_count:130,prompt_eval_count:800})};
 };
}
test('local models both configured for 15-minute deadline and all logical CPUs',()=>{
 assert.equal(QWEN_MODEL_TIMEOUT_MS,900000);
 assert.ok(QWEN_MODEL_CPU_THREADS>=1);
});
test('future-only watcher ignores preexisting cards and audits both models after new card',async()=>{
 const x=fixture(),calls=[];
 try{
  const state=initializeFutureQwenCardAudit({root:x.root});
  assert.equal(state.cutoffs.telegram_events,1);
  let r=await processFutureQwenCards({root:x.root,fetchImpl:stub(calls),now:2000000000000,settleMs:0});
  assert.equal(r.processed,undefined);
  assert.equal(calls.length,0);
  x.db.prepare('INSERT INTO telegram_source_posts(channel,message_id,raw_text,source_url,published_at,parse_status)'+
   ' VALUES(?,?,?,?,?,?)')
   .run('new',2,'20 November 2026. New event at Club, beginning 20:00.',
    'https://t.me/new/2',1795000000,'event');
  x.db.prepare('INSERT INTO telegram_events(id,channel,message_id,title,event_date,event_time,venue)'+
   ' VALUES(?,?,?,?,?,?,?)').run(2,'new',2,'New event','2026-11-20','20:00','Club');
  r=await processFutureQwenCards({root:x.root,fetchImpl:stub(calls),now:2000000001000,settleMs:0});
  assert.equal(r.processed,2);
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(c=>c.model),QWEN_EVENT_MODELS);
  const results=readFileSync(join(x.root,'data','local-qwen-audit','future-results.jsonl'),'utf8')
   .split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(results.length,2);
  assert.equal(results[0].status,'ok');
  assert.equal(results[0].comparison.fields.date.matches,1);
  assert.equal(results[1].structure.predictedStructure,'single_event');
  assert.equal(x.db.prepare('SELECT count(*) as n FROM telegram_events').get().n,2);
  await processFutureQwenCards({root:x.root,fetchImpl:stub(calls),now:2000000004000,settleMs:0});
  assert.equal(calls.length,2);
  const report=JSON.parse(readFileSync(join(x.root,'data','local-qwen-audit','future-report.json'),'utf8'));
  assert.equal(report.totalAttempts,2);
  assert.equal(report.pendingGroups,0);
 }finally{x.db.close();rmSync(x.root,{recursive:true,force:true})}
});
test('same shared production prompt is reused for future extraction',()=>{
 const p=buildPublicEventTextExtractionPrompts({post:{sourceUrl:'https://t.me/new/2'},
  sourceText:'Event      Club\n\n\n\n 20 November',confirmedPoster:false});
 assert.equal(p.userPrompt.includes('Event  Club'),true);
 assert.equal(p.userPrompt.includes('Event      Club'),false);
 assert.ok(p.systemPrompt.includes('multiple_events'));
 assert.ok(p.systemPrompt.includes('theater_repertoire'));
});
test('missing model is not silently skipped or marked complete',async()=>{
 const x=fixture();
 try{
  initializeFutureQwenCardAudit({root:x.root});
  x.db.prepare('INSERT INTO telegram_events(id,channel,message_id,title) VALUES(?,?,?,?)')
   .run(3,'new',3,'New card');
  const v=await processFutureQwenCards({root:x.root,now:2000000000000,settleMs:0,
   fetchImpl:async()=>({ok:false,status:503,json:async()=>({})})});
  assert.equal(v.status,'models-not-ready');
  const state=initializeFutureQwenCardAudit({root:x.root});
  assert.equal(Object.keys(state.pending).length,1);
 }finally{x.db.close();rmSync(x.root,{recursive:true,force:true})}
});
