import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {randomInt} from 'node:crypto';
import {evidenceKind} from './botSelfEvidenceWorker.js';
export function sampleChatLearning(db,{peerId,botId,limit=80}) {
 const sample=[],before=[],pending=[];let seen=0;
 const cols=db.prepare('PRAGMA table_info(vk_message_archive)').all().map(x=>x.name);
 const scope=cols.includes('source_peer_id')?' AND source_peer_id=peer_id':'';
 const parent=db.prepare('SELECT conversation_message_id id,sender_id,text,created_at FROM vk_message_archive WHERE peer_id=?'+scope+' AND conversation_message_id=? LIMIT 1');
 for(const row of db.prepare('SELECT conversation_message_id id,sender_id,text,raw_message_json raw,created_at FROM vk_message_archive WHERE peer_id=?'+scope+' ORDER BY conversation_message_id').iterate(peerId)) {
  if(!row.text)continue;let raw={};try{raw=JSON.parse(row.raw||'{}');}catch{}
  const message={id:row.id,senderId:row.sender_id,text:row.text.slice(0,500),reactions:raw.reactions||null,at:row.created_at};
  for(const p of pending)p.after.push(message);
  for(let i=pending.length-1;i>=0;i--)if(pending[i].after.length>=2)pending.splice(i,1);
  if(Number(row.sender_id)===botId&&evidenceKind(row.text)==='ordinary'&&before.some(m=>m.senderId>0)){
   const reply=raw.reply_message||raw.replyMessage;
   const source=reply?.conversation_message_id?parent.get(peerId,reply.conversation_message_id):null;
   const verified=source&&source.sender_id>0&&(!reply.from_id||Number(reply.from_id)===Number(source.sender_id))&&(!reply.date||Number(reply.date)===Number(source.created_at))&&(!reply.peer_id||Number(reply.peer_id)===Number(peerId));
   if(!verified){before.push(message);if(before.length>2)before.shift();continue;}
   const request={id:source.id,senderId:source.sender_id,text:String(source.text||'').slice(0,2000)};
   const episode={id:row.id,request,before:before.slice(),answer:message,after:[]};seen++;
   if(sample.length<limit)sample.push(episode);else{const n=randomInt(seen);if(n<limit)sample[n]=episode;}
   pending.push(episode);
  }
  before.push(message);if(before.length>2)before.shift();
 }
 // Temporal holdout: no neighboring turns in both train and evaluation.
 sample.sort((a,b)=>Number(a.answer.at)-Number(b.answer.at)||a.id-b.id);
 const split=Math.max(0,sample.length-Math.ceil(sample.length/5));
 const boundary=Number(sample[split]?.answer.at)||0;
 return {peerId,botId,available:seen,train:sample.slice(0,split).filter(e=>!boundary||boundary-Number(e.answer.at)>300),holdout:sample.slice(split)};
}
if(parentPort&&workerData?.kind==='chat-learning'){
 let db;try{db=new DatabaseSync(workerData.databasePath,{readOnly:true});parentPort.postMessage({ok:true,sample:sampleChatLearning(db,workerData)});}
 catch(e){parentPort.postMessage({ok:false,error:e.message});}finally{db?.close();}
}
