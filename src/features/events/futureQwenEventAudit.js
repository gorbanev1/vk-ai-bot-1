import {createHash} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildPublicEventTextExtractionPrompts} from './publicEventExtractionPrompts.js';
import {QWEN_EVENT_MODELS,QWEN_MODEL_TIMEOUT_MS,
    runLocalQwenEventModel,compareQwenEventCards,loadQwenCardGroups} from './localQwenEventModels.js';

const TABLE_KEYS={
 vk_events:row=>'vk_source_posts:'+String(row.screen_name)+':'+String(row.post_id),
 telegram_events:row=>'telegram_source_posts:'+String(row.channel)+':'+String(row.message_id),
 vk_chat_events:row=>'vk_chat_source_messages:'+String(row.peer_id)+':'+String(row.conversation_message_id),
 manual_events:row=>'manual_events:'+String(row.id),
};
const TABLE_NAMES=Object.keys(TABLE_KEYS);
let running=false,timer=null;
const folderOf=root=>join(root,'data','local-qwen-audit');
const pathOf=root=>join(folderOf(root),'future-state.json');
const logOf=root=>join(folderOf(root),'future-results.jsonl');
const summaryOf=root=>join(folderOf(root),'future-report.json');

function store(root,state){
 const path=pathOf(root),tmp=path+'.'+process.pid+'.tmp';
 writeFileSync(tmp,JSON.stringify(state,null,2),'utf8');
 renameSync(tmp,path);
}
function openDatabase(root){
 return new DatabaseSync(join(root,'data','bot.sqlite'),{readOnly:true});
}
function loadSaved(root){
 return existsSync(logOf(root))?readFileSync(logOf(root),'utf8')
  .split(/\r?\n/u).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}):[];
}
export function initializeFutureQwenCardAudit({root}={}){
 if(!root)throw new Error('Root directory required');
 mkdirSync(folderOf(root),{recursive:true});
 if(existsSync(pathOf(root))){
  const state=JSON.parse(readFileSync(pathOf(root),'utf8'));
  if(state?.version!==1||!state.cutoffs||!state.pending)
   throw new Error('Unsupported/corrupted future Qwen card audit checkpoint');
  return state;
 }
 const db=openDatabase(root),cutoffs={};
 try{
  for(const table of TABLE_NAMES)
   cutoffs[table]=Number(db.prepare('SELECT COALESCE(MAX(id),0) as max_id FROM '+table).get()?.max_id||0);
 }finally{db.close()}
 const state={version:1,createdAt:new Date().toISOString(),cutoffs,pending:{},
  completedGroups:0,completedAttempts:0};
 store(root,state);
 return state;
}
function discover(root,state,now){
 const db=openDatabase(root);
 let added=0;
 try{
  for(const table of TABLE_NAMES){
   const rows=db.prepare('SELECT * FROM '+table+' WHERE id>? ORDER BY id ASC')
    .all(Number(state.cutoffs[table]||0));
   for(const row of rows){
    const id=TABLE_KEYS[table](row);
    let pending=state.pending[id];
    if(!pending)pending=state.pending[id]={
     sourceId:id,firstSeenAt:now,lastSeenAt:now,cardReferences:[]};
    pending.lastSeenAt=now;
    if(!pending.cardReferences.some(x=>x.table===table&&x.id===row.id))
     pending.cardReferences.push({table,id:Number(row.id)});
    state.cutoffs[table]=Math.max(Number(state.cutoffs[table]||0),Number(row.id)||0);
    added++;
   }
  }
 }finally{db.close()}
 if(added)store(root,state);
 return added;
}
function sourceFallback(root,pending){
 const db=openDatabase(root);
 const rows=[];
 try{
  for(const ref of pending.cardReferences){
   if(!TABLE_KEYS[ref.table])continue;
   const row=db.prepare('SELECT * FROM '+ref.table+' WHERE id=? LIMIT 1').get(ref.id);
   if(row)rows.push(row);
  }
 }finally{db.close()}
 const text=rows.map(r=>String(r.source_segment_text||r.description||r.evidence||'').trim())
  .filter(Boolean).join('\n\n');
 const g={id:pending.sourceId,sourceType:'missing-source-post',sourceUrl:String(rows[0]?.source_url||''),
  sourceText:text.slice(0,22000),inputQuality:'derived-card-only',publishedAt:null,
  baselineParseStatus:'event',rows:rows.map(r=>({
   id:r.id,title:r.title,event_date:r.event_date,time:r.event_time,
   venue:r.venue,participants:r.participants,price:r.price,
   description:r.description,evidence:r.evidence,event_tags_json:r.event_tags_json,
   structure:r.structure_decision||'',status:r.status||''
  }))};
 return g;
}
const fingerprint=(group,model)=>createHash('sha256').update(JSON.stringify({
 v:2,id:group.id,model,source:group.sourceText,
 cards:group.rows.map(row=>[row.id,row.title,row.event_date,row.time,row.venue])
})).digest('hex');
function reportFuture(root){
 const records=loadSaved(root),byModel={};
 for(const model of QWEN_EVENT_MODELS){
  const attempts=records.filter(x=>x.model===model);
  const accepted=attempts.filter(x=>x.status==='ok');
  byModel[model]={attempts:attempts.length,
   ok:accepted.length,failed:attempts.filter(x=>x.status==='failed').length,
   skipped:attempts.filter(x=>x.status==='skipped').length,
   comparedCards:accepted.reduce((n,x)=>n+Number(x.comparison?.storedCount||0),0),
   agreement:accepted.reduce((n,x)=>n+Number(x.comparison?.pairs?.filter(p=>p.matched).length||0),0)};
 }
 const state=JSON.parse(readFileSync(pathOf(root),'utf8'));
 const summary={updatedAt:new Date().toISOString(),mode:'new-cards-only',
  historicalBackfill:false,readOnly:true,totalAttempts:records.length,
  completedGroups:state.completedGroups,pendingGroups:Object.keys(state.pending).length,
  models:byModel};
 writeFileSync(summaryOf(root),JSON.stringify(summary,null,2),'utf8');
 return summary;
}
function describeStatus(group,out){
 return {
  baselineStructure:group.rows.map(r=>r.structure).find(Boolean)||'',
  predictedStructure:out.parsed.structure,
  baselineCards:group.rows.length,predictedCards:out.parsed.events.length,
  modelHasEvent:!['not_event','uncertain'].includes(out.parsed.structure)
 };
}
export async function processFutureQwenCards({
 root,fetchImpl=fetch,now=Date.now(),settleMs=90000
}={}){
 const state=initializeFutureQwenCardAudit({root});
 const added=discover(root,state,now);
 const queued=Object.values(state.pending)
  .filter(p=>now-Number(p.lastSeenAt||0)>=Math.max(0,Number(settleMs)||0))
  .sort((a,b)=>a.firstSeenAt-b.firstSeenAt);
 if(!queued.length)return {status:'idle',added,report:reportFuture(root)};
 let available=new Set();
 try{
  const response=await fetchImpl('http://127.0.0.1:11434/api/tags',
   {signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('Ollama tags endpoint unavailable');
  const models=await response.json();
  available=new Set((models.models||[]).map(x=>String(x.name)));
 }catch{return {status:'models-not-ready',added,report:reportFuture(root)}}
 const pending=queued[0];
 const group=loadQwenCardGroups(root).find(g=>g.id===pending.sourceId)
  ||sourceFallback(root,pending);
 const output=loadSaved(root);
 const prior=new Set(output.map(x=>x.fingerprint));
 let processed=0,last=null,unavailable=0;
 for(const model of QWEN_EVENT_MODELS){
  if(!available.has(model)){unavailable++;continue}
  const fp=fingerprint(group,model);
  if(prior.has(fp))continue;
  const item={
   fingerprint:fp,mode:'future-card',recordedAt:new Date().toISOString(),
   sourceId:group.id,sourceType:group.sourceType,
   sourceUrl:group.sourceUrl,inputQuality:group.inputQuality,
   model,cardReferences:pending.cardReferences,
   cardIds:group.rows.map(r=>r.id),
   cards:group.rows,sourceCharCount:String(group.sourceText||'').length,
  };
  if(String(group.sourceText||'').trim().length<35){
   item.status='skipped';item.error='Insufficient preserved source text for independent extraction';
  }else{
   const prompts=buildPublicEventTextExtractionPrompts({
    post:{sourceUrl:group.sourceUrl,publishedAt:group.publishedAt},
    sourceText:group.sourceText,confirmedPoster:false,repair:false,
    multiplicity:{},botTimeZone:'Europe/Moscow',
   });
   try{
    const out=await runLocalQwenEventModel({
     model,...prompts,fetchImpl,priority:'audit',timeoutMs:QWEN_MODEL_TIMEOUT_MS});
    item.status='ok';item.parsed=out.parsed;item.elapsedMs=out.elapsedMs;
    item.evalCount=out.evalCount;item.promptEvalCount=out.promptEvalCount;
    item.threads=out.threads;item.doneReason=out.doneReason;
    item.comparison=compareQwenEventCards(group.rows,out.parsed);
    item.structure=describeStatus(group,out);
   }catch(e){
    item.status='failed';item.error=String(e?.message||e).slice(0,600);
   }
  }
  appendFileSync(logOf(root),JSON.stringify(item)+'\n','utf8');
  prior.add(fp);processed++;last=item;state.completedAttempts+=1;
  store(root,state);
 }
 // Do not discard a pending source until both models have been attempted.
 const bothDone=QWEN_EVENT_MODELS.every(model=>prior.has(fingerprint(group,model)));
 if(bothDone){
  delete state.pending[pending.sourceId];state.completedGroups+=1;store(root,state);
 }
 return {status:bothDone?'completed':unavailable?'waiting-model':'partial',
  added,processed,last,report:reportFuture(root)};
}
export function startFutureQwenCardAudit({
 root,intervalMs=30000,initialDelayMs=45000,logger=console,
 sendReport=null // function({vk,telegram,report}) to send daily report
}={}){
 if(timer)return timer;
 const state=initializeFutureQwenCardAudit({root});
 logger.log('[FUTURE QWEN CARD AUDIT READY]',
  'source=only-new-cards','tracked-tables='+TABLE_NAMES.length,
  'cutoffs='+JSON.stringify(state.cutoffs),
  'allowed-hours=3-6');
 let reportSentToday=false;
 async function tick(){
  if(running)return;
  const now=new Date();
  const moscowHour=new Date(now.toLocaleString('en-US',{timeZone:'Europe/Moscow'})).getHours();
  // Reset report flag at midnight
  if(moscowHour===0&&reportSentToday)reportSentToday=false;
  // Send report at 6:00 (once per day)
  if(moscowHour===6&&!reportSentToday&&sendReport){
   try{
    const summary=reportFuture(root);
    await sendReport({summary});
    reportSentToday=true;
    logger.log('[FUTURE QWEN CARD AUDIT] Daily report sent');
   }catch(e){logger.warn('[FUTURE QWEN CARD AUDIT] Report send failed:',
    String(e?.message||e).slice(0,200))}
  }
  // Only run audit between 3:00 and 6:00 Moscow time
  if(moscowHour<3||moscowHour>=6)return;
  running=true;
  try{
   const r=await processFutureQwenCards({root});
   if(r.processed)logger.log('[FUTURE QWEN CARD AUDIT]',
    r.last.model,r.last.sourceId,r.last.status,'ms='+String(r.last.elapsedMs||0));
  }catch(e){logger.warn('[FUTURE QWEN CARD AUDIT ERROR]',
   String(e?.message||e).slice(0,250))}
  finally{running=false}
 }
 timer=setInterval(()=>void tick(),Math.max(10000,intervalMs));
 timer.unref?.();
 const starter=setTimeout(()=>void tick(),Math.max(1000,initialDelayMs));
 starter.unref?.();
 return timer;
}
