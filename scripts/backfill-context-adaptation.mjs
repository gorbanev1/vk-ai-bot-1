import {DatabaseSync} from 'node:sqlite';
import {resolveMainDatabasePath,resolveRuntimeDataDirectory} from '../src/infrastructure/database/runtimePaths.js';
import {createContextAdaptationStore} from '../src/features/personality/contextAdaptation.js';
import {isPotentialContextPreference,parseVkHistoryRecord} from '../src/features/personality/contextAdaptationHistory.js';
import {join} from 'node:path';
import {existsSync} from 'node:fs';

const LIMIT=1500,DRY=process.argv.includes('--dry-run');
const mainPath=resolveMainDatabasePath();
const queuePath=join(resolveRuntimeDataDirectory(),'context-adaptation.sqlite');
if(!existsSync(mainPath))throw new Error('Production history not found');
const db=new DatabaseSync(mainPath,{readOnly:true,timeout:3000});
db.exec('PRAGMA query_only=ON');
const store=DRY?null:createContextAdaptationStore({filePath:queuePath});
const vkPeers=db.prepare('SELECT DISTINCT peer_id FROM vk_message_archive WHERE peer_id>=2000000000 AND peer_id<3000000000 ORDER BY peer_id').all().map(x=>Number(x.peer_id));
const vkRecent=db.prepare('SELECT peer_id,conversation_message_id,sender_id,created_at,text,is_outbox,action_type,raw_message_json FROM vk_message_archive WHERE peer_id=? ORDER BY created_at DESC,conversation_message_id DESC LIMIT ?');
const telegramPeers=db.prepare('SELECT DISTINCT peer_id FROM messages WHERE (peer_id>3000000000 OR peer_id< -3000000000) ORDER BY peer_id').all().map(x=>Number(x.peer_id));
const tgRecent=db.prepare('SELECT peer_id,conversation_message_id,sender_id,created_at,text FROM messages WHERE peer_id=? ORDER BY created_at DESC,conversation_message_id DESC LIMIT ?');
let totalScanned=0,totalEligible=0,totalQueued=0;
console.log('CONTEXT_ADAPTATION_HISTORY_START',JSON.stringify({vkChats:vkPeers.length,otherChats:telegramPeers.length,limitPerChat:LIMIT,dryRun:DRY}));
try{
 for(const peer of vkPeers){
  const rows=vkRecent.all(peer,LIMIT).reverse(),candidate=[];
  for(const record of rows){
   const normalized=parseVkHistoryRecord(record);
   if(isPotentialContextPreference(normalized))candidate.push(normalized);
  }
  let queued=0;if(store?.isEnabled(peer))for(const row of candidate){
   if(store.observe({peerId:row.peerId,senderId:row.senderId,messageId:row.messageId,text:row.text,platform:'vk'}))queued++;
  }
  totalScanned+=rows.length;totalEligible+=candidate.length;totalQueued+=queued;
  console.log('BACKFILL_CHAT',JSON.stringify({platform:'vk',peer,scanned:rows.length,eligible:candidate.length,newlyQueued:queued,skippedDisabled:Boolean(store&&!store.isEnabled(peer))}));
 }
 for(const peer of telegramPeers){
  const rows=tgRecent.all(peer,LIMIT).reverse(),candidate=[];
  for(const row of rows)if(isPotentialContextPreference({text:row.text,senderId:row.sender_id}))candidate.push(row);
  let queued=0;if(store?.isEnabled(peer))for(const row of candidate){
   const messageId=Number(row.conversation_message_id);
   if(store.observe({peerId:peer,senderId:row.sender_id,messageId,text:row.text,platform:'telegram'}))queued++;
  }
  totalScanned+=rows.length;totalEligible+=candidate.length;totalQueued+=queued;
  console.log('BACKFILL_CHAT',JSON.stringify({platform:'telegram',peerLabel:String(peer).slice(0,6)+'***',scanned:rows.length,eligible:candidate.length,newlyQueued:queued,skippedDisabled:Boolean(store&&!store.isEnabled(peer))}));
 }
 console.log('CONTEXT_ADAPTATION_HISTORY_DONE',JSON.stringify({scanned:totalScanned,eligible:totalEligible,newlyQueued:totalQueued,note:'All source messages screened; only plausible explicit preferences are queued for model-ladder review.'}));
}finally{db.close();store?.close()}
