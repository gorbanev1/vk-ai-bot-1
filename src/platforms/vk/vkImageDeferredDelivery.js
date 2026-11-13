import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID,randomInt} from 'node:crypto';
import {buildVkConversationReplySendParams} from '../../features/ai/vkImageEditReplyTransport.js';

// All three paths verified by actual image replies to VK chat 2000000008.
// Both native paths use a fresh server URL for each attempt.
export const VK_IMAGE_FALLBACK_METHODS=Object.freeze(['native-direct','native-fresh-server','vk-io-sdk']);
export const VK_IMAGE_ATTEMPTS_PER_METHOD=2;
export const VK_IMAGE_BETWEEN_METHOD_ATTEMPTS_MS=60_000;
export const VK_IMAGE_BETWEEN_ROUNDS_MS=Object.freeze([600_000,900_000]);
export const VK_IMAGE_MAX_ATTEMPTS=VK_IMAGE_FALLBACK_METHODS.length*VK_IMAGE_ATTEMPTS_PER_METHOD*3;

export function vkImageFallbackStep(attempt){
 const index=Number(attempt);
 if(!Number.isInteger(index)||index<0||index>=VK_IMAGE_MAX_ATTEMPTS)throw Error('Invalid image delivery attempt index');
 const perRound=VK_IMAGE_FALLBACK_METHODS.length*VK_IMAGE_ATTEMPTS_PER_METHOD;
 return {
  round:Math.floor(index/perRound)+1,
  method:VK_IMAGE_FALLBACK_METHODS[Math.floor(index%perRound/VK_IMAGE_ATTEMPTS_PER_METHOD)],
  methodAttempt:index%VK_IMAGE_ATTEMPTS_PER_METHOD+1,
  attempt:index+1,
 };
}
export function vkImageFallbackDelayAfter(attempt){
 const step=vkImageFallbackStep(attempt);
 if(step.attempt===VK_IMAGE_MAX_ATTEMPTS)return null;
 if(step.methodAttempt===1)return VK_IMAGE_BETWEEN_METHOD_ATTEMPTS_MS;
 if(step.method===VK_IMAGE_FALLBACK_METHODS.at(-1))return VK_IMAGE_BETWEEN_ROUNDS_MS[step.round-1];
 return 0;
}

export function createVkImageDeferredDelivery({databasePath,now=Date.now}={}){
 if(!databasePath)throw Error('VK image delivery database path is required');
 mkdirSync(dirname(databasePath),{recursive:true});
 const db=new DatabaseSync(databasePath,{timeout:2000});
 db.exec('PRAGMA journal_mode=WAL');
 db.exec("CREATE TABLE IF NOT EXISTS vk_image_deferred_delivery(id TEXT PRIMARY KEY,peer_id INTEGER NOT NULL,original_cmid INTEGER NOT NULL DEFAULT 0,file_path TEXT NOT NULL,mime_type TEXT NOT NULL,filename TEXT NOT NULL,caption TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempt INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,attachment TEXT NOT NULL DEFAULT '',random_id INTEGER NOT NULL,last_error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,pipeline_version INTEGER NOT NULL DEFAULT 2)");
 if(!db.prepare('PRAGMA table_info(vk_image_deferred_delivery)').all().some(x=>x.name==='pipeline_version'))
  db.exec('ALTER TABLE vk_image_deferred_delivery ADD COLUMN pipeline_version INTEGER NOT NULL DEFAULT 1');
 db.exec('CREATE INDEX IF NOT EXISTS vk_image_deferred_due ON vk_image_deferred_delivery(status,next_at)');
 // After crash use the SAME random_id, avoiding a duplicate on VK.
 db.prepare("UPDATE vk_image_deferred_delivery SET status='pending' WHERE status='processing'").run();
 // Migrate pending jobs from obsolete 1/5/10/20 minute scheme; keep delivered/failed terminal.
 db.prepare("UPDATE vk_image_deferred_delivery SET attempt=0,next_at=?,pipeline_version=2 WHERE status='pending' AND pipeline_version<2").run(now());
 function enqueue({peerId,originalCmid=0,filePath,mimeType='image/png',filename='gpt-image.png',
  caption='🎨 Картинка по запросу (повторная доставка)',attachment=''}) {
  const peer=Number(peerId),cmid=Number(originalCmid)||0;
  if(!Number.isSafeInteger(peer)||peer<2000000000||peer>=3000000000)throw Error('Deferred VK images require a group chat peer');
  const absolute=resolve(String(filePath||''));
  if(!filePath||!/\.(?:png|jpe?g|webp|gif)$/iu.test(absolute))throw Error('Deferred image file path invalid');
  if(attachment&&!/^photo-?\d+_\d+/u.test(String(attachment)))throw Error('Deferred image attachment invalid');
  const id=randomUUID(),t=now();
  db.prepare("INSERT INTO vk_image_deferred_delivery(id,peer_id,original_cmid,file_path,mime_type,filename,caption,status,attempt,next_at,attachment,random_id,created_at,updated_at,pipeline_version) VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?,?,?,2)")
   .run(id,peer,cmid,absolute,String(mimeType).slice(0,60),String(filename).slice(0,100),
    String(caption).slice(0,500),t,String(attachment||''),randomInt(1,2147483647),t,t);
  return {id,nextAt:t,maxAttempts:VK_IMAGE_MAX_ATTEMPTS};
 }
 function claimDue(limit=1){
  db.exec('BEGIN IMMEDIATE');
  try{
   const rows=db.prepare("SELECT * FROM vk_image_deferred_delivery WHERE status='pending' AND next_at<=? ORDER BY next_at,id LIMIT ?").all(now(),Math.max(1,Math.min(3,limit)));
   const mark=db.prepare("UPDATE vk_image_deferred_delivery SET status='processing',updated_at=? WHERE id=? AND status='pending'");
   for(const row of rows)mark.run(now(),row.id);
   db.exec('COMMIT');return rows;
  }catch(error){db.exec('ROLLBACK');throw error}
 }
 function setAttachment(id,attachment){
  if(!/^photo-?\d+_\d+/u.test(String(attachment||'')))throw Error('VK image recovery attachment invalid');
  db.prepare("UPDATE vk_image_deferred_delivery SET attachment=?,updated_at=? WHERE id=? AND status='processing'").run(String(attachment),now(),id);
 }
 function delivered(id){
  return db.prepare("UPDATE vk_image_deferred_delivery SET status='delivered',updated_at=?,last_error='' WHERE id=? AND status='processing'").run(now(),id).changes>0;
 }
 function failed(job,error){
  const nextAttempt=Number(job.attempt)+1,delay=vkImageFallbackDelayAfter(Number(job.attempt)),done=delay===null;
  const clearAttachment=Number(error?.code)===100&&/attachment|photo|image|фотограф|вложени/iu.test(String(error?.message||''));
  const nextAt=done?0:now()+delay;
  db.prepare("UPDATE vk_image_deferred_delivery SET status=?,attempt=?,next_at=?,last_error=?,updated_at=?,attachment=CASE WHEN ?=1 THEN '' ELSE attachment END WHERE id=? AND status='processing'")
   .run(done?'failed':'pending',nextAttempt,nextAt,String(error?.message||error||'unknown').slice(0,220),
    now(),clearAttachment?1:0,job.id);
  return {done,nextAttempt,delayMs:delay,nextAt:done?null:nextAt};
 }
 const get=id=>db.prepare('SELECT * FROM vk_image_deferred_delivery WHERE id=?').get(id)||null;
 const stats=()=>db.prepare('SELECT status,COUNT(*) count FROM vk_image_deferred_delivery GROUP BY status').all();
 return {enqueue,claimDue,setAttachment,delivered,failed,get,stats,close:()=>db.close()};
}

export async function deliverDueVkImages({queue,upload,send,readImage,isValidImage,onEvent=()=>{},onDelivered=()=>{}}){
 const jobs=queue.claimDue(1);
 for(const job of jobs){
  const step=vkImageFallbackStep(job.attempt);
  try{
   let attachment=String(job.attachment||'');
   if(!attachment){
    const buffer=readImage(job.file_path);
    if(!isValidImage(buffer))throw Error('Saved image missing or invalid');
    attachment=await upload(job,buffer,step.method);
    queue.setAttachment(job.id,attachment);
   }
   // VK can return messageId=0 on an actually delivered reply (verified in live chat).
   await send(job,attachment);
   queue.delivered(job.id);
   try{onDelivered(job)}catch(error){onEvent({event:'cleanup-warning',id:job.id,error:String(error?.message||error).slice(0,100)})}
   onEvent({event:'delivered',peer:job.peer_id,id:job.id,...step,reusedUpload:Boolean(job.attachment)});
  }catch(error){
   const state=queue.failed(job,error);
   onEvent({event:state.done?'failed':'retry',peer:job.peer_id,id:job.id,...step,
    nextAt:state.nextAt,delayMs:state.delayMs,error:String(error?.message||error).slice(0,120)});
  }
 }
 return jobs.length;
}
export async function sendDeferredVkPhotoMessage({client,job,attachment}){
 const payload={peer_id:job.peer_id,random_id:job.random_id,attachment,message:job.caption};
 const cmid=Number(job.original_cmid);
 if(Number.isSafeInteger(cmid)&&cmid>0){
  payload.forward=buildVkConversationReplySendParams({
   peerId:job.peer_id,conversationMessageId:cmid,randomId:job.random_id,
   message:job.caption,attachment,
  }).forward;
 }
 try{return await client.api.messages.send(payload)}catch(error){
  if(!payload.forward||!(Number(error?.code)===100||/forwarded message not found/iu.test(String(error?.message||''))))throw error;
  delete payload.forward;
  return client.api.messages.send(payload);
 }
}
