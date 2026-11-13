import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { availableParallelism } from 'node:os';
import { buildPublicEventTextExtractionPrompts } from './publicEventExtractionPrompts.js';

export const QWEN_EVENT_MODELS = Object.freeze(['qwen3.5:4b']);
const OLLAMA_URL = 'http://127.0.0.1:11434';
export const QWEN_MODEL_TIMEOUT_MS = 15 * 60 * 1000;
export const QWEN_MODEL_CPU_THREADS = Math.max(1, availableParallelism());
const FIELDS = ['title','date','time','venue','participants','price','tags','announcement','evidence'];
const STRUCTURES = new Set(['single_event','single_event_program','shared_schedule_event',
 'theater_repertoire','multiple_events','not_event','uncertain']);
const EVENT_JSON_SCHEMA = {
 type:'object',additionalProperties:true,
 properties:{
  structure:{type:'string',enum:[...STRUCTURES]},
  structure_reason:{type:'string'},
  events:{type:'array',items:{
   type:'object',additionalProperties:true,
   properties:{
    title:{type:'string'},date:{type:'string'},time:{type:['string','null']},
    venue:{type:'string'},participants:{type:'string'},price:{type:'string'},
    announcement:{type:'string'},evidence:{type:'string'},
    tags:{type:'array',items:{type:'string'}}
   },
   required:['title','date','venue'],
  }},
 },
 required:['structure','structure_reason','events'],
};
const norm = v => String(v ?? '').toLocaleLowerCase('ru-RU').replace(/[\p{P}\p{S}]+/gu,' ').replace(/\s+/gu,' ').trim();
let auditTimer=null,auditBusy=false,active=false;
const priorityQueue=[],auditQueue=[];
function drain(){
 if(active)return;
 const job=priorityQueue.shift()||auditQueue.shift();
 if(!job)return;
 active=true;
 Promise.resolve().then(job.work).then(job.resolve,job.reject).finally(()=>{active=false;drain()});
}
function scheduleModel(work,priority='live'){
 return new Promise((resolve,reject)=>{
  (priority==='audit'?auditQueue:priorityQueue).push({work,resolve,reject});drain();
 });
}

export function validateQwenEventJson(input) {
 let obj=input;
 if(typeof input==='string'){
  const text=input.trim();
  try{obj=JSON.parse(text)}
  catch{
   const begin=text.indexOf('{'),end=text.lastIndexOf('}');
   if(begin<0||end<=begin)throw new Error('No JSON response');
   obj=JSON.parse(text.slice(begin,end+1));
  }
 }
 if(!obj||typeof obj!=='object'||Array.isArray(obj))throw new Error('JSON must be an object');
 if(!STRUCTURES.has(String(obj.structure||'')))throw new Error('Invalid event structure');
 if(typeof obj.structure_reason!=='string'||!obj.structure_reason.trim())throw new Error('Missing structure_reason');
 if(!Array.isArray(obj.events))throw new Error('Missing events array');
 const n=obj.events.length;
 const valid=['single_event','single_event_program','shared_schedule_event','theater_repertoire'].includes(obj.structure)
  ? n===1 : obj.structure==='multiple_events' ? n>=2&&n<=20 : n===0;
 if(!valid)throw new Error('Structure-event count mismatch');
 for(const e of obj.events){
  if(!e||typeof e!=='object'||Array.isArray(e))throw new Error('Invalid event metadata');
  if(!('date' in e)||!('title' in e)||!('venue' in e))throw new Error('Missing event fields');
 }
 return obj;
}
async function callLocalModel({model,systemPrompt,userPrompt,fetchImpl=fetch,timeoutMs=QWEN_MODEL_TIMEOUT_MS}={}){
 if(!QWEN_EVENT_MODELS.includes(model))throw new Error('Unknown local Qwen model');
 if(!String(systemPrompt||'').trim()||!String(userPrompt||'').trim())throw new Error('Empty parser prompt');
 // Keep exactly the same production event prompt for the router and Qwen.
 // Allocate enough context for Russian instructions + the full announcement.
 // The previous 1600-token cap on 1.7B truncated valid multi-event JSON.
 const small=model==='qwen3:1.7b';
 const inputSize=Buffer.byteLength(String(systemPrompt)+String(userPrompt),'utf8');
 const contextTokens=inputSize>22000?16384:12288;
 const outputTokens=inputSize>22000?6144:4096;
 const boundedTimeout=Math.max(1000,Math.min(QWEN_MODEL_TIMEOUT_MS,
     Number(timeoutMs)||QWEN_MODEL_TIMEOUT_MS));
 const abort=new AbortController();
 const timer=setTimeout(()=>abort.abort(new Error('Ollama timeout')),Math.max(1000,Math.min(QWEN_MODEL_TIMEOUT_MS,boundedTimeout)));
 timer.unref?.();
 const start=Date.now();
 try{
  const res=await fetchImpl(OLLAMA_URL+'/api/chat',{method:'POST',signal:abort.signal,
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({model,stream:false,format:EVENT_JSON_SCHEMA,think:false,keep_alive:'5m',
    messages:[{role:'system',content:systemPrompt},{role:'user',content:userPrompt}],
    options:{temperature:0,num_ctx:contextTokens,num_predict:outputTokens,num_thread:QWEN_MODEL_CPU_THREADS,num_batch:512,repeat_penalty:small?1.14:1.0,repeat_last_n:256}})});
  const body=await res.json();
  if(!res.ok||body?.error)throw new Error('Ollama HTTP '+res.status+' '+String(body.error||'error').slice(0,180));
  let parsed;
  try{parsed=validateQwenEventJson(body?.message?.content||'')}
  catch(error){
   throw new Error('Invalid event JSON ('+String(error?.message||error)+
    '); outputChars='+String(body?.message?.content||'').length+
    '; evalCount='+Number(body?.eval_count||0)+
    '; maxOutputTokens='+outputTokens+
    '; doneReason='+String(body?.done_reason||'unknown'));
  }
  return {model,text:JSON.stringify(parsed),parsed,elapsedMs:Date.now()-start,
   threads:QWEN_MODEL_CPU_THREADS,contextTokens,outputTokens,
   doneReason:String(body?.done_reason||''),evalCount:Number(body.eval_count||0),
   promptEvalCount:Number(body.prompt_eval_count||0)};
 }finally{clearTimeout(timer)}
}
export function runLocalQwenEventModel(args={}){
 return scheduleModel(()=>callLocalModel(args),args.priority==='audit'?'audit':'live');
}
export async function generateLocalQwenText(args={}){
 const failures=[];
 for(const model of QWEN_EVENT_MODELS){
  try{return await runLocalQwenEventModel({...args,model})}
  catch(e){failures.push(model+': '+String(e?.message||e).slice(0,180))}
 }
 throw new Error('Local Qwen fallback exhausted: '+failures.join(' | '));
}
export function compareQwenEventCards(cards,parsed){
 const predictions=Array.isArray(parsed?.events)?parsed.events:[],used=new Set(),pairs=[];
 for(const card of cards){
  let best=-1,bestScore=-1;
  for(let i=0;i<predictions.length;i++){
   if(used.has(i))continue;
   const p=predictions[i],d=norm(card.event_date),t=norm(card.title);
   const pt=(d&&d===norm(p.date)?5:0)+(t&&t===norm(p.title)?4:0)
    +(t&&norm(p.title)&&(t.includes(norm(p.title))||norm(p.title).includes(t))?2:0)
    +(norm(card.venue)===norm(p.venue)?1:0);
   if(pt>bestScore){bestScore=pt;best=i}
  }
  if(best<0){pairs.push({cardId:card.id,matched:false,differences:['Missing event']});continue}
  used.add(best);const p=predictions[best],agreement={},differences=[];
  for(const f of FIELDS){
   const saved=String(card[f==='date'?'event_date':f==='tags'?'event_tags_json':f==='announcement'?'description':f]??'').trim();
   const qwen=Array.isArray(p[f])?p[f].join(', '):String(p[f]??'').trim();
   const equal=norm(saved)===norm(qwen);
   agreement[f]=equal;
   if(!equal)differences.push({field:f,stored:saved.slice(0,220),qwen:qwen.slice(0,220)});
  }
  pairs.push({cardId:card.id,matched:true,agreement,differences});
 }
 const compared=pairs.filter(x=>x.matched),fields={};
 for(const f of FIELDS)fields[f]={matches:compared.filter(x=>x.agreement[f]).length,compared:compared.length};
 return {storedCount:cards.length,modelCount:predictions.length,
  unmatchedCards:pairs.filter(x=>!x.matched).length,
  extraPredictions:predictions.length-used.size,fields,pairs};
}
export function loadQwenCardGroups(root){
 const db=new DatabaseSync(join(root,'data','bot.sqlite'),{readOnly:true});
 const byId=new Map();
 try {
  const liveTables=[
   ['vk_source_posts','vk_events',
    row=>String(row.screen_name)+':'+String(row.post_id),
    row=>String(row.screen_name)+':'+String(row.post_id)],
   ['telegram_source_posts','telegram_events',
    row=>String(row.channel)+':'+String(row.message_id),
    row=>String(row.channel)+':'+String(row.message_id)],
   ['vk_chat_source_messages','vk_chat_events',
    row=>String(row.peer_id)+':'+String(row.conversation_message_id),
    row=>String(row.peer_id)+':'+String(row.conversation_message_id)],
  ];
  const cardsFor=(table,keyFn)=>{
   const m=new Map();
   for(const row of db.prepare('SELECT * FROM '+table).all()){
    const key=keyFn(row);
    if(!m.has(key))m.set(key,[]);
    m.get(key).push({
     id:row.id,title:row.title,event_date:row.event_date,
     time:row.event_time,venue:row.venue,
     participants:row.participants,price:row.price,
     description:row.description,evidence:row.evidence,event_tags_json:row.event_tags_json,
     structure:row.structure_decision||'',status:row.status||''
    });
   }
   return m;
  };
  for(const [sourceTable,eventTable,sourceKey,cardKey] of liveTables){
   const cards=cardsFor(eventTable,cardKey);
   for(const row of db.prepare('SELECT * FROM '+sourceTable).all()){
    const key=sourceKey(row),id=sourceTable+':'+key;
    const raw=String(row.raw_text||'').trim();
    let imageFacts=[];
    try{
     const facts=JSON.parse(String(row.image_vision_facts_json||'[]'));
     if(Array.isArray(facts))imageFacts=facts
      .filter(f=>f&&typeof f.text==='string'&&f.text.trim())
      .slice(0,12).map(f=>'[IMAGE '+String(f.index||1)+']\n'+f.text.trim().slice(0,5500));
    }catch{}
    const combined=[raw,...imageFacts].filter(Boolean).join('\n\n');
    const publishTime=Number(row.published_at||row.created_at||0);
    const sourceUrl=String(row.source_url||row.canonical_post_url||row.conversation_url||'').trim();
    // Source text and image facts are already stored by scrapers. Append facts
    // only when there are meaningful saved OCR details; do not fabricate any.
    const group={
     id,sourceType:sourceTable,sourceUrl,
     sourceText:combined.slice(0,22000),
     inputQuality:raw?(imageFacts.length?'source-plus-stored-vision':'original-source')
      :(imageFacts.length?'stored-vision-only':'missing'),
     imageVisionFactCount:imageFacts.length,
     publishedAt:Number.isSafeInteger(publishTime)&&publishTime>1000000000?publishTime:null,
     baselineParseStatus:String(row.parse_status||'unknown'),
     rows:cards.get(key)||[],allCardMatches:cards.get(key)||[]
    };
    byId.set(id,group);
   }
  }
  // Manually submitted cards are additional source records. They do not have
  // corresponding raw scraper items and must not disappear from the audit.
  for(const row of db.prepare('SELECT * FROM manual_events').all()){
   const source=String(row.source_text||row.source_segment_text||'').trim()||
    String(row.evidence||row.description||'').trim();
   const id='manual_events:'+String(row.id);
   byId.set(id,{id,sourceType:'manual_events',
    sourceUrl:String(row.source_url||''),
    sourceText:source.slice(0,22000),inputQuality:row.source_text?'original-source':'derived-card',
    publishedAt:null,baselineParseStatus:'manual',
    rows:[{id:row.id,title:row.title,event_date:row.event_date,
     time:row.event_time,venue:row.venue,participants:row.participants,price:row.price,
     structure:row.structure_decision||'',status:row.status||''}]});
  }
  // Process actual scraper posts before manually entered test/owner cards.
  // Historical deduplication retains original source snapshots and removed
  // cards; include them without adding archived cards to the live card totals.
  for(const archived of db.prepare('SELECT source_type,event_id,event_row_json FROM event_dedupe_archive').all()){
   let value={};
   try{value=JSON.parse(String(archived.event_row_json||'{}'))}catch{continue}
   const event=value.eventRow;
   if(!event||typeof event!=='object')continue;
   const origin=value.sourceRow&&typeof value.sourceRow==='object'?value.sourceRow:{};
   const type=String(archived.source_type||'');
   let id='';
   if(type==='vk')id='vk_source_posts:'+String(event.screen_name||origin.screen_name)+':'+String(event.post_id||origin.post_id);
   else if(type==='telegram')id='telegram_source_posts:'+String(event.channel||origin.channel)+':'+String(event.message_id||origin.message_id);
   else if(type==='vk_chat')id='vk_chat_source_messages:'+String(event.peer_id||origin.peer_id)+':'+String(event.conversation_message_id||origin.conversation_message_id);
   else if(type==='manual')id='manual_events:'+String(event.id);
   else id='historical:'+type+':'+String(archived.event_id);
   let g=byId.get(id);
   if(!g){
    const base=String(origin.raw_text||event.source_text||event.source_segment_text||
     event.evidence||event.description||'').trim();
    let vision=[];
    try{
     const facts=JSON.parse(String(origin.image_vision_facts_json||'[]'));
     if(Array.isArray(facts))vision=facts
      .filter(f=>f&&typeof f.text==='string'&&f.text.trim())
      .slice(0,12).map(f=>'[IMAGE '+String(f.index||1)+']\n'+f.text.trim().slice(0,5500));
    }catch{}
    const published=Number(origin.published_at||origin.created_at||0);
    g={id,sourceType:type+'_historical',
     sourceUrl:String(origin.source_url||event.source_url||origin.conversation_url||''),
     sourceText:[base,...vision].filter(Boolean).join('\n\n').slice(0,22000),
     inputQuality:origin.raw_text?'archived-original-source':'archived-card-segment',
     publishedAt:Number.isSafeInteger(published)&&published>1000000000?published:null,
     baselineParseStatus:'archived-event',rows:[],archivedRows:[],
     imageVisionFactCount:vision.length};
    byId.set(id,g);
   }
   if(!Array.isArray(g.archivedRows))g.archivedRows=[];
   g.archivedRows.push({
    id:'archived:'+type+':'+String(archived.event_id),
    title:event.title,event_date:event.event_date,time:event.event_time,
    venue:event.venue,participants:event.participants,price:event.price,
    description:event.description,evidence:event.evidence,
    event_tags_json:event.event_tags_json,
    structure:event.structure_decision||'',status:event.status||'',archived:true
   });
  }
  const rank=g=>g.sourceType==='manual_events'?3:g.rows.length>0?0:
    g.baselineParseStatus.startsWith('not_event')?1:2;
  return [...byId.values()].sort((a,b)=>rank(a)-rank(b)||a.id.localeCompare(b.id));
 }finally{db.close()}
}

const hashGroup=(g,model)=>createHash('sha256').update(JSON.stringify({
 id:g.id,text:g.sourceText,cards:g.rows,archived:g.archivedRows||[],model,version:5,publishedAt:g.publishedAt,baselineParseStatus:g.baselineParseStatus})).digest('hex');
function report(root,stored,groups){
 const byModel={};
 for(const model of QWEN_EVENT_MODELS){
  const rows=stored.filter(x=>x.model===model),ok=rows.filter(x=>x.status==='ok'),fields={};
  for(const f of FIELDS)fields[f]={
   matches:ok.reduce((n,x)=>n+Number(x.comparison?.fields?.[f]?.matches||0),0),
   compared:ok.reduce((n,x)=>n+Number(x.comparison?.fields?.[f]?.compared||0),0)};
  byModel[model]={processed:rows.length,ok:ok.length,
   failed:rows.filter(x=>x.status==='failed').length,
   skipped:rows.filter(x=>x.status==='skipped').length,
   comparedCards:ok.reduce((n,x)=>n+Number(x.comparison?.storedCount||0),0),
   archivedComparedCards:ok.reduce((n,x)=>n+Number(x.archivedComparison?.storedCount||0),0),
   structureEvaluation:{
    known:ok.filter(x=>x.expectedStructure).length,
    matching:ok.filter(x=>x.expectedStructure&&x.expectedStructure===x.structure).length,
    mismatching:ok.filter(x=>x.expectedStructure&&x.expectedStructure!==x.structure).length,
    predicted:ok.reduce((dist,x)=>{
     dist[x.structure]=(dist[x.structure]||0)+1;return dist;},{}),
    examples:ok.filter(x=>x.expectedStructure&&x.expectedStructure!==x.structure)
     .slice(0,25).map(x=>({sourceId:x.sourceId,expected:x.expectedStructure,
      qwen:x.structure,url:x.sourceUrl}))
   },
   classification:{
    baselineEvent:ok.filter(x=>x.baselineIsEvent).length,
    baselineNotEvent:ok.filter(x=>(!x.baselineIsEvent&&x.baselineParseStatus.startsWith('not_event'))).length,
    agreesEvent:ok.filter(x=>x.baselineIsEvent&&x.predictedIsEvent===true).length,
    agreesNotEvent:ok.filter(x=>(!x.baselineIsEvent&&x.baselineParseStatus.startsWith('not_event'))&&x.predictedIsEvent===false).length,
    falsePositiveVsSaved:ok.filter(x=>(!x.baselineIsEvent&&x.baselineParseStatus.startsWith('not_event'))&&x.predictedIsEvent===true).length,
    falseNegativeVsSaved:ok.filter(x=>x.baselineIsEvent&&x.predictedIsEvent===false).length
   },fields};
 }
 const summary={generatedAt:new Date().toISOString(),sourceGroups:groups.length,
  storedCards:groups.reduce((n,g)=>n+g.rows.length,0),
  archivedCards:groups.reduce((n,g)=>n+(g.archivedRows?.length||0),0),
  baselineSourceStatuses:groups.reduce((all,g)=>{
   all[g.baselineParseStatus]=(all[g.baselineParseStatus]||0)+1;return all;},{}),
  models:byModel,
  readOnly:true,limitation:'Some historical data uses stored snippets instead of full original posts; agreement with existing cards does not prove ground-truth correctness.'};
 const folder=join(root,'data','local-qwen-audit');mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'report.json'),JSON.stringify(summary,null,2));
 return summary;
}
export async function processOneQwenAnnouncementAudit({root,fetchImpl=fetch,maxResults=1}={}){
 if(!root)throw new Error('Project root required');
 const dir=join(root,'data','local-qwen-audit'),path=join(dir,'results.jsonl');
 mkdirSync(dir,{recursive:true});
 const saved=[];
 if(existsSync(path))for(const line of readFileSync(path,'utf8').split(/\r?\n/u)){
  if(line.trim())try{saved.push(JSON.parse(line))}catch{}
 }
 const seen=new Set(saved.map(x=>x.fingerprint)),groups=loadQwenCardGroups(root);
 // Combined maximum: 100 historical attempts across ALL local models.
 const remaining=Math.max(0,100-saved.length);
 maxResults=Math.min(Math.max(0,Number(maxResults)||0),remaining);
 const existing=report(root,saved,groups);
 const models=await fetchImpl(OLLAMA_URL+'/api/tags',{signal:AbortSignal.timeout(2500)})
  .then(x=>x.json()).then(x=>new Set((x.models||[]).map(m=>m.name)))
  .catch(()=>new Set());
 if(!QWEN_EVENT_MODELS.some(m=>models.has(m)))return {status:'models-not-ready',report:existing};
 if(maxResults<=0)return {status:'inspection',performed:0,report:existing};
 let n=0,last=null;
 for(const g of groups)for(const model of QWEN_EVENT_MODELS){
  if(!models.has(model))continue;
  const fp=hashGroup(g,model);
  if(seen.has(fp))continue;
  const item={fingerprint:fp,sourceId:g.id,sourceType:g.sourceType,
   sourceUrl:g.sourceUrl,model,inputQuality:g.inputQuality,
   storedCards:g.rows,storedCount:g.rows.length,
   archivedCards:g.archivedRows||[],archivedCount:(g.archivedRows||[]).length,
   baselineParseStatus:g.baselineParseStatus,
   expectedStructure:[...g.rows,...(g.archivedRows||[])].map(x=>x.structure).find(x=>STRUCTURES.has(x))||
    (g.baselineParseStatus.startsWith('not_event')?'not_event':''),
   imageVisionFactCount:Number(g.imageVisionFactCount||0),
   publishedAt:g.publishedAt,recordedAt:new Date().toISOString()};
  if(g.sourceText.length<35){item.status='skipped';item.error='Insufficient saved source text'}
  else{
   const prompts=buildPublicEventTextExtractionPrompts({
    post:{sourceUrl:g.sourceUrl,publishedAt:g.publishedAt},
    sourceText:g.sourceText,confirmedPoster:false,repair:false,
    multiplicity:{},botTimeZone:'Europe/Moscow'});
   try{
    const out=await runLocalQwenEventModel({model,...prompts,fetchImpl,priority:'audit'});
    item.status='ok';item.json=out.parsed;
    item.structure=out.parsed.structure;item.structureReason=out.parsed.structure_reason;
    item.predictedIsEvent=!['not_event','uncertain'].includes(out.parsed.structure);
    item.baselineIsEvent=g.baselineParseStatus==='event'||g.rows.length>0||
     (g.archivedRows||[]).length>0;
    item.classificationAgreement=item.baselineIsEvent===item.predictedIsEvent;
    item.comparison=compareQwenEventCards(g.rows,out.parsed);
    item.archivedComparison=compareQwenEventCards(g.archivedRows||[],out.parsed);
    item.elapsedMs=out.elapsedMs;item.evalCount=out.evalCount;
    item.promptEvalCount=out.promptEvalCount;
   }catch(e){item.status='failed';item.error=String(e?.message||e).slice(0,320)}
  }
  appendFileSync(path,JSON.stringify(item)+'\n');
  saved.push(item);seen.add(fp);last=item;n++;report(root,saved,groups);
  if(n>=maxResults)return {status:'processed',performed:n,last};
 }
 return {status:'complete',performed:n,report:report(root,saved,groups)};
}
export function startLocalQwenAnnouncementAudit({root,initialDelayMs=45000,intervalMs=30000,logger=console}={}){
 // No historical backfill by default. Operator must explicitly re-enable.
 if(process.env.LOCAL_QWEN_EVENT_AUDIT_ENABLED!=='1'){
  logger.log('[QWEN CARD AUDIT PAUSED] no background historical model calls');
  return null;
 }
 if(auditTimer)return auditTimer;
 async function tick(){
  if(auditBusy)return;
  auditBusy=true;
  try{
   const res=await processOneQwenAnnouncementAudit({root,maxResults:1});
   if(res.performed)logger.log('[QWEN CARD AUDIT]',res.last.model,res.last.sourceId,res.last.status,
    'elapsed_ms='+String(res.last.elapsedMs||0));
  }catch(e){logger.warn('[QWEN CARD AUDIT ERROR]',String(e?.message||e).slice(0,200))}
  finally{auditBusy=false}
 }
 auditTimer=setInterval(()=>void tick(),intervalMs);
 auditTimer.unref?.();
 const starter=setTimeout(()=>void tick(),initialDelayMs);starter.unref?.();
 return auditTimer;
}
