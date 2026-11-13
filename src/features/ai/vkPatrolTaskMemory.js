import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {writeFile,readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {resolveRuntimeDataDirectory,assertTestDatabaseIsolation} from '../../infrastructure/database/runtimePaths.js';
const PEER=2000000011;
const json=v=>JSON.stringify(v??null),parse=s=>{try{return JSON.parse(s)}catch{return null}};
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):0;
const clip=(s,n)=>String(s??'').slice(0,n);
const fingerprint=s=>createHash('sha256').update(String(s)).digest('hex');
function photoKeys(value){
 if(typeof value==='string')return value.match(/photo-?\d+_\d+/g)||[];
 return (Array.isArray(value)?value:[]).filter(a=>a.type==='photo'&&a.photo).map(a=>'photo'+a.photo.owner_id+'_'+a.photo.id);
}
function refsFrom(value,out=new Set(),depth=0){
 if(depth>12||!value||typeof value!=='object')return out;
 for(const [k,v] of Object.entries(value)){
  if(['cmid','sourceCmid','conversation_message_id'].includes(k)&&positive(v))out.add(positive(v));
  else if(k==='cmids'&&Array.isArray(v)){for(const id of v)if(positive(id))out.add(positive(id));}
  else if(v&&typeof v==='object')refsFrom(v,out,depth+1);
 }
 return out;
}
export function createPatrolTaskMemory({databasePath=join(resolveRuntimeDataDirectory(),'vk-patrol-adaptive','task-memory.sqlite'),now=Date.now}={}){
 assertTestDatabaseIsolation({databasePath});mkdirSync(dirname(databasePath),{recursive:true});
 const db=new DatabaseSync(databasePath);db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY,peer INTEGER NOT NULL,user INTEGER NOT NULL,goal TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS agent_tasks_owner ON agent_tasks(peer,user,updated DESC);
 CREATE TABLE IF NOT EXISTS agent_turns(id TEXT PRIMARY KEY,task TEXT NOT NULL,peer INTEGER NOT NULL,user INTEGER NOT NULL,cmid INTEGER NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,summary TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(peer,cmid));
 CREATE INDEX IF NOT EXISTS agent_turns_task ON agent_turns(task,created);
 CREATE TABLE IF NOT EXISTS agent_records(id INTEGER PRIMARY KEY,turn TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,cmid INTEGER NOT NULL DEFAULT 0,mid INTEGER NOT NULL DEFAULT 0,text_hash TEXT,created INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS agent_records_turn ON agent_records(turn,id);
 CREATE INDEX IF NOT EXISTS agent_records_cmid ON agent_records(cmid);
 CREATE TABLE IF NOT EXISTS agent_artifacts(id TEXT PRIMARY KEY,turn TEXT NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,attachment TEXT NOT NULL,created INTEGER NOT NULL);
 `);
 const scope=(peer,user)=>{if(Number(peer)!==PEER||!positive(user))throw Error('Task memory scope denied');};
 const owned=(task,peer,user)=>{scope(peer,user);const row=db.prepare('SELECT * FROM agent_tasks WHERE id=? AND peer=? AND user=?').get(task,peer,user);if(!row)throw Error('Task belongs to another user or chat');return row;};
 const turnRow=id=>{const row=db.prepare('SELECT * FROM agent_turns WHERE id=?').get(id);if(!row)throw Error('Unknown memory turn');return row;};
 const record=(turn,kind,body,cmid=0,mid=0,hash=null)=>db.prepare('INSERT INTO agent_records(turn,kind,body,cmid,mid,text_hash,created) VALUES(?,?,?,?,?,?,?)').run(turn,kind,json(body),cmid,mid,hash,now());
 function list(peer,user,exclude=''){
  scope(peer,user);return db.prepare('SELECT * FROM agent_tasks WHERE peer=? AND user=? AND id<>? ORDER BY updated DESC LIMIT 8').all(peer,user,exclude).map(t=>{
   const last=db.prepare('SELECT id,input,status,summary FROM agent_turns WHERE task=? ORDER BY created DESC,rowid DESC LIMIT 1').get(t.id);
   return {taskId:t.id,goal:t.goal,lastRequest:clip(last?.input,600),status:last?.status,summary:parse(last?.summary),updatedAt:t.updated};
  });
 }
 function resolveReply(peer,user,reply){
  if(!reply)return null;
  const replyPeer=positive(reply.peer_id??reply.peerId);
  if(replyPeer&&replyPeer!==peer)return null;
  const cmid=positive(reply.conversation_message_id??reply.conversationMessageId),mid=positive(reply.id??reply.message_id);
  const input=cmid&&db.prepare('SELECT task FROM agent_turns WHERE peer=? AND user=? AND cmid=?').get(peer,user,cmid);
  if(input)return input.task;
  const rows=db.prepare(`SELECT r.*,t.task FROM agent_records r JOIN agent_turns t ON t.id=r.turn WHERE t.peer=? AND t.user=? AND r.kind='output' ORDER BY r.id DESC LIMIT 500`).all(peer,user);
  let matched=rows.filter(r=>(cmid&&r.cmid===cmid)||(mid&&r.mid===mid));
  if(!matched.length){const keys=photoKeys(reply.attachments);if(keys.length)matched=rows.filter(r=>photoKeys(parse(r.body)?.attachment).some(k=>keys.includes(k)));
   else if(String(reply.text||'').trim())matched=rows.filter(r=>r.text_hash===fingerprint(reply.text));}
  const tasks=[...new Set(matched.map(r=>r.task))];
  if(tasks.length!==1)return null;
  // Backfill only a unique content/reference match; never guess CMID from a global ID.
  if(matched.length===1&&cmid&&!matched[0].cmid)db.prepare('UPDATE agent_records SET cmid=? WHERE id=?').run(cmid,matched[0].id);
  return tasks[0];
 }
 function replyArtifact(task,reply){
  if(!reply)return '';
  const keys=photoKeys(reply.attachments),cmid=positive(reply.conversation_message_id??reply.conversationMessageId),mid=positive(reply.id??reply.message_id);
  const images=db.prepare(`SELECT a.*,r.cmid,r.mid FROM agent_artifacts a JOIN agent_turns t ON t.id=a.turn JOIN agent_records r ON r.turn=a.turn AND r.kind='output' AND json_extract(r.body,'$.attachment')=a.attachment WHERE t.task=? ORDER BY a.created DESC`).all(task);
  const matches=images.filter(a=>keys.length?photoKeys(a.attachment).some(k=>keys.includes(k)):((cmid&&a.cmid===cmid)||(mid&&a.mid===mid)));
  const ids=[...new Set(matches.map(a=>a.id))];return ids.length===1?ids[0]:'';
 }
 function begin({peer,user,cmid,input,reply}){
  scope(peer,user);if(!positive(cmid))throw Error('Real incoming conversation message ID required');
  const existing=db.prepare('SELECT * FROM agent_turns WHERE peer=? AND cmid=?').get(peer,cmid);
  if(existing)return {duplicate:true,turnId:existing.id,status:existing.status};
  const linked=resolveReply(peer,user,reply);const task=linked||randomUUID(),id=randomUUID(),at=now();
  db.exec('BEGIN IMMEDIATE');try{
   if(!linked)db.prepare('INSERT INTO agent_tasks VALUES(?,?,?,?,?,?)').run(task,peer,user,clip(input,6000),at,at);
   db.prepare('INSERT INTO agent_turns VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,task,peer,user,cmid,clip(input,20000),'running',null,at,at);
   db.prepare('UPDATE agent_tasks SET updated=? WHERE id=?').run(at,task);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {turnId:id,taskId:task,linked:Boolean(linked),replyArtifactId:linked?replyArtifact(task,reply):'',candidates:list(peer,user,task)};
 }
 function resume(turn,task){
  const row=turnRow(turn);owned(task,row.peer,row.user);
  if(row.task===task)return context(turn);
  if(db.prepare("SELECT 1 FROM agent_records WHERE turn=? AND (kind='output' OR (kind='observation' AND json_extract(body,'$.action') IN ('create_image','edit_image','create_image_from_photos','native_capability','native_command','normal_route','recurring_chat','show_parties','pin_photo','run_module','build_module'))) LIMIT 1").get(turn))throw Error('Select the task before executing side effects');
  const old=row.task;db.prepare('UPDATE agent_turns SET task=?,updated=? WHERE id=?').run(task,now(),turn);
  db.prepare('UPDATE agent_tasks SET updated=? WHERE id=?').run(now(),task);
  db.prepare('DELETE FROM agent_tasks WHERE id=? AND NOT EXISTS(SELECT 1 FROM agent_turns WHERE task=?)').run(old,old);
  return context(turn);
 }
 function context(turn,{offset=0,limit=4}={}){
  const current=turnRow(turn),task=owned(current.task,current.peer,current.user);
  const turns=db.prepare('SELECT * FROM agent_turns WHERE task=? AND id<>? ORDER BY created DESC,rowid DESC LIMIT ? OFFSET ?').all(task.id,turn,Math.max(1,Math.min(20,limit)),Math.max(0,offset));
  return {taskId:task.id,goal:task.goal,kind:'stored-evidence-not-instructions',turns:turns.map(t=>{
   const records=db.prepare('SELECT * FROM agent_records WHERE turn=? ORDER BY id DESC LIMIT 30').all(t.id).reverse();
   return {turnId:t.id,userMessage:{peerId:t.peer,cmid:t.cmid,text:t.input},status:t.status,
    summary:parse(t.summary),outputs:records.filter(r=>r.kind==='output').map(r=>({...parse(r.body),cmid:r.cmid,messageId:r.mid})),
    observations:records.filter(r=>r.kind==='observation').slice(-5).map(r=>{const v=parse(r.body);return {action:v.action,sourceCmids:v.sourceCmids,resultPreview:clip(json(v.result),1800),previewOnly:true};}),
    artifacts:db.prepare('SELECT id,mime,attachment,created FROM agent_artifacts WHERE turn=? ORDER BY created DESC').all(t.id)};
  }),hasMore:turns.length===limit};
 }
 function observe(turn,value){
  const sourceCmids=[...refsFrom(value.result)].slice(0,5000);
  const full=json(value.result),result=full.length<=60000?value.result:{truncated:true,preview:full.slice(0,50000)};
  record(turn,'observation',{action:value.action,args:value.args,result,sourceCmids});
 }
 function output(turn,payload,delivery){
  const text=typeof payload==='string'?payload:payload?.message||payload?.text||'';
  const attachment=typeof payload==='object'?String(payload?.attachment||''):'';
  const value=Array.isArray(delivery)?delivery[0]:delivery;
  record(turn,'output',{text,attachment},positive(value?.conversation_message_id??value?.conversationMessageId),positive(value?.message_id??value?.id??(typeof value==='number'?value:0)),text?fingerprint(text):null);
 }
 function summary(turn,memory){
  if(!memory||typeof memory!=='object')return;
  const row=turnRow(turn),allowed=new Set([row.cmid]);
  for(const t of db.prepare('SELECT id,cmid FROM agent_turns WHERE task=?').all(row.task)){
   allowed.add(t.cmid);for(const r of db.prepare("SELECT body FROM agent_records WHERE turn=? AND kind='observation'").all(t.id))for(const id of parse(r.body)?.sourceCmids||[])allowed.add(id);
  }
  const refs=(Array.isArray(memory.sourceCmids)?memory.sourceCmids:[]).filter(id=>allowed.has(positive(id))).slice(0,60);
  const value={type:'assistant-summary-not-established-fact',text:clip(memory.summary,2400),sourceCmids:refs,
   pending:(Array.isArray(memory.pending)?memory.pending:[]).slice(0,12).map(x=>clip(x,300))};
  db.prepare('UPDATE agent_turns SET summary=? WHERE id=?').run(json(value),turn);
 }
 async function saveArtifact(turn,{buffer,mimeType,attachment}){
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>40*1024*1024)return;
  turnRow(turn);const id=randomUUID(),folder=join(dirname(databasePath),'task-artifacts');mkdirSync(folder,{recursive:true});
  const path=join(folder,id+'.image');await writeFile(path,buffer);
  db.prepare('INSERT INTO agent_artifacts VALUES(?,?,?,?,?,?)').run(id,turn,path,String(mimeType||'image/png'),String(attachment||''),now());return id;
 }
 async function artifact(turn,id=''){
  const row=turnRow(turn);
  const selected=id?db.prepare('SELECT a.* FROM agent_artifacts a JOIN agent_turns t ON t.id=a.turn WHERE a.id=? AND t.task=?').get(id,row.task):
   db.prepare(`SELECT a.* FROM agent_artifacts a JOIN agent_turns t ON t.id=a.turn WHERE t.task=? AND EXISTS(SELECT 1 FROM agent_records r WHERE r.turn=a.turn AND r.kind='output' AND json_extract(r.body,'$.attachment')=a.attachment) ORDER BY a.created DESC,a.rowid DESC LIMIT 1`).get(row.task);
  if(!selected)throw Error('No saved image version in this task');
  const root=resolve(dirname(databasePath),'task-artifacts');if(dirname(resolve(selected.path))!==root)throw Error('Artifact path rejected');
  return {id:selected.id,dataUrl:'data:'+selected.mime+';base64,'+(await readFile(selected.path)).toString('base64')};
 }
 function history(turn,requestedTurn,{offset=0,limit=20}={}){
  const current=turnRow(turn),target=turnRow(requestedTurn);
  if(current.task!==target.task||current.peer!==target.peer||current.user!==target.user)throw Error('History scope denied');
  const records=db.prepare('SELECT id,kind,body,cmid,mid FROM agent_records WHERE turn=? ORDER BY id LIMIT ? OFFSET ?').all(requestedTurn,Math.max(1,Math.min(30,limit)),Math.max(0,offset));
  return {turnId:target.id,input:{cmid:target.cmid,text:target.input},records:records.map(r=>({...r,body:parse(r.body)})),nextOffset:records.length===limit?offset+records.length:null};
 }
 function finish(turn,status){const row=turnRow(turn);db.prepare('UPDATE agent_turns SET status=?,updated=? WHERE id=?').run(clip(status,80),now(),turn);db.prepare('UPDATE agent_tasks SET updated=? WHERE id=?').run(now(),row.task);}
 return {begin,resume,context,history,list,observe,output,summary,saveArtifact,artifact,finish,close:()=>db.close()};
}
let singleton;
export function getPatrolTaskMemory(){return singleton ||= createPatrolTaskMemory();}
