import {randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const DAY_MS=86400000;
export function endOfNextCalendarWeek(at=new Date(),timeZone='Europe/Moscow'){
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
 const get=type=>Number(parts.find(part=>part.type===type)?.value);
 const today=new Date(Date.UTC(get('year'),get('month')-1,get('day'),12));
 const monday0=(today.getUTCDay()+6)%7;
 return new Date(today.getTime()+(13-monday0)*DAY_MS).toISOString().slice(0,10);
}
export function rangeNeedsOwnerApproval(range,at=new Date(),timeZone='Europe/Moscow'){
 if(!range||range.invalid||range.pastOnly)return false;
 const cutoff=endOfNextCalendarWeek(at,timeZone);
 if(!/^\d{4}-\d{2}-\d{2}$/u.test(String(range.toDate||'')))return true;
 return String(range.toDate)>cutoff;
}
const encode=value=>JSON.stringify(value??null);
const parse=value=>{try{return JSON.parse(value)}catch{return null}};
function validated(input){
 const platform=String(input?.platform||'').toLowerCase();
 const peerId=String(input?.peerId||''),requesterId=String(input?.requesterId||'');
 if(!['vk','telegram'].includes(platform)||!peerId||!requesterId||
   !input?.range||typeof input.range!=='object'||typeof input?.options!=='object')
  throw Error('Extended-range approval requires typed chat, requester and range');
 if(encode(input).length>16000)throw Error('Extended-range approval request too large');
 return {
  platform,peerId,requesterId,
  chatTitle:String(input.chatTitle||'').trim().slice(0,120),
  requesterName:String(input.requesterName||'').trim().slice(0,120),
  routeMethod:String(input.routeMethod||'range-approval').slice(0,110),
  allParties:Boolean(input.allParties),range:input.range,options:input.options,
 };
}
export function createExtendedRangeApprovalStore({databasePath,now=()=>Date.now(),ttlMs=DAY_MS}={}){
 if(!databasePath)throw Error('Approval storage path required');
 mkdirSync(dirname(databasePath),{recursive:true});
 const db=new DatabaseSync(databasePath);
 db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000;');
 db.exec([
  'CREATE TABLE IF NOT EXISTS extended_party_range_approvals(',
  'id TEXT PRIMARY KEY,request_key TEXT NOT NULL,',
  'created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,',
  'status TEXT NOT NULL,platform TEXT NOT NULL,peer_id TEXT NOT NULL,',
  'requester_id TEXT NOT NULL,request_json TEXT NOT NULL,',
  "decided_at INTEGER NOT NULL DEFAULT 0,decided_channel TEXT NOT NULL DEFAULT '',",
  "last_error TEXT NOT NULL DEFAULT ''",
  ');CREATE INDEX IF NOT EXISTS extended_party_range_status_idx ',
  'ON extended_party_range_approvals(status,expires_at,request_key);'
 ].join(''));
 const existingColumns=new Set(db.prepare('PRAGMA table_info(extended_party_range_approvals)').all().map(row=>row.name));
 const additions={
  notification_sent_at:'INTEGER NOT NULL DEFAULT 0',
  notification_next_attempt_at:'INTEGER NOT NULL DEFAULT 0',
  notification_claim_until:'INTEGER NOT NULL DEFAULT 0',
  notification_attempts:'INTEGER NOT NULL DEFAULT 0',
  notification_error:"TEXT NOT NULL DEFAULT ''",
  owner_vk_message_id:'INTEGER NOT NULL DEFAULT 0',
  owner_telegram_message_id:'INTEGER NOT NULL DEFAULT 0',
 };
 for(const [column,type] of Object.entries(additions))
  if(!existingColumns.has(column))db.exec('ALTER TABLE extended_party_range_approvals ADD COLUMN '+column+' '+type);
 const select=db.prepare('SELECT * FROM extended_party_range_approvals WHERE id=?');
 const existing=db.prepare("SELECT * FROM extended_party_range_approvals WHERE request_key=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1");
 const insert=db.prepare('INSERT INTO extended_party_range_approvals (id,request_key,created_at,expires_at,status,platform,peer_id,requester_id,request_json) VALUES(?,?,?,?,?,?,?,?,?)');
 const decideQuery=db.prepare("UPDATE extended_party_range_approvals SET status=?,decided_at=?,decided_channel=? WHERE id=? AND status='pending' AND expires_at>?");
 const beginDelivery=db.prepare("UPDATE extended_party_range_approvals SET status='delivering' WHERE id=? AND status='approved' AND notification_sent_at>0");
 const readyDelivery=db.prepare("SELECT * FROM extended_party_range_approvals WHERE status='approved' AND notification_sent_at>0 AND created_at>=? ORDER BY decided_at ASC LIMIT ?");
 const finishQuery=db.prepare("UPDATE extended_party_range_approvals SET status=?,last_error=? WHERE id=? AND status='delivering'");
 const unpack=row=>row?{
  id:row.id,createdAt:row.created_at,expiresAt:row.expires_at,
  status:row.status,decidedChannel:row.decided_channel,lastError:row.last_error,
  notificationSentAt:row.notification_sent_at||0,notificationAttempts:row.notification_attempts||0,
  ownerVkMessageId:row.owner_vk_message_id||0,ownerTelegramMessageId:row.owner_telegram_message_id||0,
  ...parse(row.request_json),
 }:null;
 function request(input){
  const data=validated(input);
  // Display metadata never changes the dedupe key.
  const {chatTitle,requesterName,...keyData}=data;
  const key=createHash('sha256').update(encode(keyData)).digest('hex');
  const pending=existing.get(key,now());
  if(pending)return {record:unpack(pending),created:false};
  const id=randomBytes(12).toString('hex'),at=now();
  insert.run(id,key,at,at+ttlMs,'pending',data.platform,data.peerId,data.requesterId,encode(data));
  return {record:unpack(select.get(id)),created:true};
 }
 function get(id){return unpack(select.get(String(id||'')))}
 function decide(id,decision,channel){
  if(!['approve','deny'].includes(decision)||!['vk','telegram'].includes(channel))
   return {ok:false,reason:'invalid-decision'};
  const status=decision==='approve'?'approved':'denied',at=now();
  const changed=decideQuery.run(status,at,channel,String(id||''),at);
  const record=get(id);
  if(!record)return {ok:false,reason:'not-found'};
  if(!changed.changes)return {ok:false,reason:record.expiresAt<=at&&record.status==='pending'?'expired':'already-'+record.status,record};
  return {ok:true,status,record};
 }
 function startDelivery(id){return beginDelivery.run(String(id||'')).changes===1}
 function listApprovedReady(limit=10){return readyDelivery.all(now()-2*DAY_MS,Math.max(1,Math.min(30,Number(limit)||10))).map(unpack)}
 function finish(id,status,error=''){
  if(!['delivered','delivery-failed'].includes(status))throw Error('Invalid approval delivery status');
  return finishQuery.run(status,String(error||'').slice(0,600),String(id||'')).changes===1;
 }
 const ownerMessageQuery=db.prepare("UPDATE extended_party_range_approvals SET owner_vk_message_id=CASE WHEN ?='vk' THEN ? ELSE owner_vk_message_id END,owner_telegram_message_id=CASE WHEN ?='telegram' THEN ? ELSE owner_telegram_message_id END WHERE id=?");
 function noteOwnerMessage(id,channel,messageId){
  const mid=Number(messageId)||0;
  if(!['vk','telegram'].includes(channel)||!Number.isSafeInteger(mid)||mid<=0)return false;
  return ownerMessageQuery.run(channel,mid,channel,mid,String(id||'')).changes===1;
 }
 const claimNotice=db.prepare("UPDATE extended_party_range_approvals SET notification_claim_until=?,notification_attempts=notification_attempts+1 WHERE id=? AND status IN ('approved','denied','delivered','delivery-failed') AND notification_sent_at=0 AND notification_next_attempt_at<=? AND notification_claim_until<=?");
 const markNoticeSent=db.prepare("UPDATE extended_party_range_approvals SET notification_sent_at=?,notification_claim_until=0,notification_next_attempt_at=0,notification_error='' WHERE id=? AND notification_sent_at=0");
 const markNoticeError=db.prepare("UPDATE extended_party_range_approvals SET notification_claim_until=0,notification_next_attempt_at=?,notification_error=? WHERE id=? AND notification_sent_at=0");
 const pendingNotices=db.prepare("SELECT * FROM extended_party_range_approvals WHERE status IN ('approved','denied','delivered','delivery-failed') AND notification_sent_at=0 AND notification_next_attempt_at<=? AND notification_claim_until<=? AND created_at>=? ORDER BY decided_at ASC LIMIT ?");
 function takeNotification(id){const at=now();return claimNotice.run(at+45_000,String(id||''),at,at).changes===1}
 function notificationSent(id){return markNoticeSent.run(now(),String(id||'')).changes===1}
 function notificationFailed(id,error){
  const current=get(id),delays=[60_000,300_000,600_000,1_200_000];
  const delay=delays[Math.min(delays.length-1,Math.max(0,Number(current?.notificationAttempts||1)-1))];
  return markNoticeError.run(now()+delay,String(error||'').slice(0,350),String(id||'')).changes===1;
 }
 function listUnnotified(limit=15){
  const at=now();
  return pendingNotices.all(at,at,at-2*DAY_MS,Math.max(1,Math.min(50,Number(limit)||15))).map(unpack);
 }
 return Object.freeze({request,get,decide,finish,startDelivery,listApprovedReady,noteOwnerMessage,takeNotification,
  notificationSent,notificationFailed,listUnnotified,close(){db.close()},databasePath});
}
