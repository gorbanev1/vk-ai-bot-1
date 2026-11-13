import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {getDueCalendarSpecialRollups,getDueCalendarLongRollups} from '../ai/calendarSummarySchedule.js';
import {getLocalDateString,zonedDateTimeToUtcMilliseconds} from '../../shared/date.js';
const TZ='Europe/Moscow';
export function activityPlans(now=new Date()){
 const sec=Math.floor(+now/1000),day=getLocalDateString(now,TZ);
 const at=(d,h=0,m=0)=>Math.floor(zonedDateTimeToUtcMilliseconds(d,h,m,TZ)/1000);
 const daily={key:'day:'+day,label:'За день '+day,startAt:at(day),endAt:at(day,23,55),scheduledAt:at(day,23,55)};
 const future=new Date(+now+300000);
 const periods=[...getDueCalendarSpecialRollups(future,TZ,120),...getDueCalendarLongRollups(future,TZ,120).filter(p=>p.periodType==='calendar-month')];
 return [daily,...periods.map(p=>({key:p.periodType+':'+p.periodKey,label:p.label||({'workweek':'Рабочая неделя','weekend':'Выходные','full-week':'Полная неделя'}[p.periodType]+' — '+p.periodKey),startAt:at(p.startDate,p.startHour||0),endAt:at(p.endDate,p.endHour||0,p.endMinute||0),scheduledAt:p.scheduledAt-300}))]
 .filter(p=>sec>=p.scheduledAt&&sec<p.scheduledAt+120).map(p=>({...p,snapshotAt:Math.min(p.endAt,p.scheduledAt)}));
}
export const plainActivityName=value=>String(value||'Участник').replace(/\[.*?\|([^\]]+)\]/gu,'$1').replace(/https?:\/\/\S+|www\.\S+/gu,'').replace(/[@*_|<>\[\]\x60]/gu,'').replace(/\s+/gu,' ').trim().slice(0,60)||'Участник';
export function formatActivityStats(plan,rows){
 const clock=new Date(plan.snapshotAt*1000).toLocaleString('ru-RU',{timeZone:TZ,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
 return ['📊 Активность · '+plan.label,'Срез на '+clock+' МСК',
 'Реакции — на сообщения периода; время постановки неизвестно.','',
 ...rows.slice(0,30).map((r,i)=>(i+1)+'. '+plainActivityName(r.name)+'\n   Сообщений: '+r.messages+' · Поставил: '+(r.givenKnown?r.given:Number(r.given)>0?'≥'+r.given:'—')+' · Получил: '+(r.receivedKnown?r.received:'—')),
 '', 'Реакции VK проверены через отдельный API, если доступен. ≥ — минимум подтверждённых реакций; — — точное количество неизвестно.'].join('\n');
}
export function collectActivity(db,plan){
 const peers=db.prepare(`SELECT peer_id FROM (
  SELECT DISTINCT peer_id FROM messages WHERE created_at>=? AND created_at<?
  UNION SELECT DISTINCT peer_id FROM vk_message_archive WHERE created_at>=? AND created_at<?
 ) ORDER BY peer_id`).all(plan.startAt,plan.snapshotAt,plan.startAt,plan.snapshotAt),result=[];
 for(const {peer_id:peer}of peers){
  const identity=db.prepare("SELECT external_id FROM platform_identities WHERE platform='telegram' AND entity_type='peer' AND internal_id=?").get(peer);
  let platform='vk',external=String(peer);
  if(identity){if(!/^(supergroup|group):-[0-9]+$/.test(identity.external_id))continue;platform='telegram';external=identity.external_id.split(':')[1];}
  else if(peer<2000000000||peer>2147483647)continue;
  const rows=(platform==='vk'
   ?db.prepare(`SELECT id,count(*) AS messages FROM (
       SELECT a.sender_id AS id FROM vk_message_archive a
        WHERE a.peer_id=? AND a.created_at>=? AND a.created_at<?
          AND a.sender_id>0 AND a.is_outbox=0 AND (a.action_type IS NULL OR a.action_type='')
       UNION ALL
       SELECT m.sender_id AS id FROM messages m
        WHERE m.peer_id=? AND m.created_at>=? AND m.created_at<? AND m.sender_id>0
          AND NOT EXISTS (SELECT 1 FROM vk_message_archive a
            WHERE a.peer_id=m.peer_id
              AND a.conversation_message_id=m.conversation_message_id
              AND a.sender_id=m.sender_id AND a.created_at=m.created_at)
     ) GROUP BY id ORDER BY messages DESC,id ASC`).all(
        peer,plan.startAt,plan.snapshotAt,peer,plan.startAt,plan.snapshotAt)
   :db.prepare('SELECT sender_id AS id,count(*) AS messages FROM messages WHERE peer_id=? AND created_at>=? AND created_at<? AND sender_id<>0 GROUP BY sender_id ORDER BY messages DESC,id ASC')
     .all(peer,plan.startAt,plan.snapshotAt))
   .filter(r=>platform==='telegram'||r.id>0).slice(0,30);
  if(!rows.length)continue;
  const byId=new Map(rows.map(r=>[r.id,{...r,given:0,received:0,givenKnown:false,receivedKnown:false}]));
  if(platform==='vk'){
   const hasSnapshots=Boolean(db.prepare(
     "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vk_activity_reaction_snapshots'"
   ).get());
   const snapshots=new Map(hasSnapshots?db.prepare(
     'SELECT conversation_message_id,counters_json FROM vk_activity_reaction_snapshots WHERE peer_id=? AND message_created_at>=? AND message_created_at<?'
   ).all(peer,plan.startAt,plan.snapshotAt).map(row=>{
     let parsed=null;try{parsed=JSON.parse(row.counters_json)}catch{}
     return [Number(row.conversation_message_id),Array.isArray(parsed)?parsed:null];
   }):[]);
   const missingReceived=new Set();
   let allChecked=true,allActorsKnown=true;
   function addReactions(senderId,reactions,known){
     const author=byId.get(Number(senderId));
     if(!known){
       allChecked=false;
       if(author)missingReceived.add(Number(senderId));
       return;
     }
     for(const reaction of reactions){
       const count=Math.max(0,Number(reaction?.count)||0);
       if(author)author.received+=count;
       const ids=[...new Set(Array.isArray(reaction?.user_ids)?reaction.user_ids.map(Number):[])].filter(id=>Number.isSafeInteger(id)&&id>0);
       if(ids.length<count)allActorsKnown=false;
       for(const id of ids){
         const actor=byId.get(id);
         if(actor)actor.given++;
       }
     }
   }
   const archivedCmids=new Set();
   for(const item of db.prepare(
      "SELECT source_peer_id,conversation_message_id,sender_id,raw_message_json FROM vk_message_archive"+
      " WHERE peer_id=? AND created_at>=? AND created_at<? AND (action_type IS NULL OR action_type='')"
   ).iterate(peer,plan.startAt,plan.snapshotAt)){
     const cmid=Number(item.conversation_message_id);
     archivedCmids.add(cmid);
     const normalized=Number(item.source_peer_id)===Number(peer)?snapshots.get(cmid):undefined;
     if(normalized!==undefined){
       addReactions(item.sender_id,normalized,Array.isArray(normalized));
     }else{
       let raw;try{raw=JSON.parse(item.raw_message_json||'{}')}catch{raw={}}
       addReactions(item.sender_id,raw?.reactions,Array.isArray(raw?.reactions));
     }
   }
   // Live messages without a matching archive entry can also receive reactions.
   // A reused CMID must never be counted twice.
   for(const live of db.prepare(
      'SELECT conversation_message_id,sender_id FROM messages WHERE peer_id=? AND created_at>=? AND created_at<?'
   ).iterate(peer,plan.startAt,plan.snapshotAt)){
     const cmid=Number(live.conversation_message_id);
     if(archivedCmids.has(cmid))continue;
     const counters=snapshots.get(cmid);
     addReactions(live.sender_id,counters,Array.isArray(counters));
   }
   for(const row of byId.values()){
     row.receivedKnown=!missingReceived.has(row.id);
     row.givenKnown=allChecked&&allActorsKnown;
   }
  }else if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='activity_reaction_snapshots'").get()){
   const authors=new Map(db.prepare('SELECT conversation_message_id,sender_id FROM messages WHERE peer_id=? AND created_at>=? AND created_at<?').all(peer,plan.startAt,plan.snapshotAt).map(m=>[m.conversation_message_id,m.sender_id]));
   const snapshots=db.prepare('SELECT * FROM activity_reaction_snapshots WHERE peer_id=?').all(peer);
   const anonymousTotals=new Set(snapshots.filter(r=>r.actor_id===0).map(r=>r.message_id));
   for(const r of snapshots){
    if(!authors.has(r.message_id))continue;const author=byId.get(authors.get(r.message_id)),actor=byId.get(r.actor_id);
    if(author&&(r.actor_id===0||!anonymousTotals.has(r.message_id))){author.received+=r.reaction_count;author.receivedKnown=true;}
    if(actor){actor.given+=r.reaction_count;actor.givenKnown=true;}
   }
  }
  for(const row of byId.values()){
   const cached=platform==='vk'?db.prepare('SELECT full_name AS name FROM vk_user_name_cache WHERE user_id=?').get(row.id):null;
   const participant=db.prepare('SELECT display_name AS name FROM communication_participants WHERE peer_id=? AND user_id=?').get(peer,row.id);
   row.name=cached?.name||participant?.name||'Участник '+row.id;
  }
  const endpoint=db.prepare('SELECT endpoint_key FROM auto_summary_settings WHERE peer_id=?').get(peer)?.endpoint_key;
  result.push({peerId:peer,platform,externalPeerId:external,endpointKey:endpoint||'vk:primary',rows:[...byId.values()]});
 }return result;
}
export function collectActivityAsync(dbPath,plan){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{dbPath,plan},execArgv:[]});
  const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Activity statistics worker timeout'));},120000);
  worker.once('message',result=>{clearTimeout(timer);result.error?reject(new Error(result.error)):resolve(result.data);});
  worker.once('error',e=>{clearTimeout(timer);reject(e);});
  worker.once('exit',code=>{clearTimeout(timer);if(code)reject(new Error('Activity worker exit '+code));});
 });
}
if(!isMainThread&&workerData?.plan){
 let db;try{db=new DatabaseSync(workerData.dbPath,{readOnly:true});parentPort.postMessage({data:collectActivity(db,workerData.plan)});}catch(e){parentPort.postMessage({error:e.message});}finally{db?.close();}
}
export function createActivityScheduler({collect,loadState,saveState,send,refreshNames=async()=>{},now=()=>new Date(),logger=console}){
 let busy=false;
 return {async tick(){
  if(busy)return;busy=true;
  try{
   for(const plan of activityPlans(now())){
    const targets=await collect(plan);
    for(const target of targets){
     const key=plan.key+':'+target.platform+':'+target.externalPeerId;
     const state=loadState()||{};if(state[key])continue;
     await refreshNames(target).catch(e=>logger.warn('[ACTIVITY NAMES]',e.message));
     state[key]={status:'sending',at:Math.floor(+now()/1000)};saveState(state);
     try{await send(target,formatActivityStats(plan,target.rows),key);state[key].status='sent';}
     catch(e){state[key].status='delivery_unknown';logger.error('[ACTIVITY SEND]',key,e.message);}
     saveState(state);
    }
   }
  }catch(e){logger.error('[ACTIVITY STATS]',e.message);}finally{busy=false;}
 }};
}