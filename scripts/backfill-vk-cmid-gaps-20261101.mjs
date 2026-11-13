import 'dotenv/config';
import {VK} from 'vk-io';
import {DatabaseSync} from 'node:sqlite';
const groupId=233007447;
const cutoff=Math.floor(Date.now()/1000)-7*86400;
const db=new DatabaseSync('data/bot.sqlite',{readOnly:true});
const peers=db.prepare('SELECT source_peer_id peer,COUNT(*) n, MIN(conversation_message_id) lo,MAX(conversation_message_id) hi FROM vk_message_archive WHERE peer_id=source_peer_id AND source_peer_id>=2000000000 AND created_at>=? GROUP BY source_peer_id ORDER BY n DESC').all(cutoff);
const work=[];
for(const p of peers){
 const ids=db.prepare('SELECT DISTINCT conversation_message_id cmid FROM vk_message_archive WHERE peer_id=source_peer_id AND source_peer_id=? AND created_at>=?').all(p.peer,cutoff).map(x=>x.cmid).filter(x=>Number.isSafeInteger(x)&&x>0);
 const present=new Set(ids),min=Math.min(...ids),max=Math.max(...ids);
 if(!Number.isFinite(min)||max-min>100000){console.log('SKIP HUGE OR INVALID',p.peer,min,max);continue;}
 const missing=[];for(let id=min;id<=max;id++){if(!present.has(id))missing.push(id);}
 const row={peer:p.peer,span:[min,max],existing:ids.length,missing:missing.length};
 console.log('VK GAP PLAN',JSON.stringify(row));work.push({...row,ids:missing});
}
db.close();
if(process.argv.includes('--plan')){console.log('VK PLAN COMPLETE',work.reduce((s,p)=>s+p.missing,0),'gap CMIDs');process.exit(0);}
const {saveVkMessageArchiveRecord,saveIncomingMessage}=await import('../src/infrastructure/database/index.js');
const vk=new VK({token:process.env.VK_TOKEN,apiVersion:'5.199'});
let totalFound=0,totalArchive=0,totalIncoming=0,totalErrors=0;
for(const task of work){
 let peerFound=0,peerArchived=0,peerIncoming=0,peerErrors=0;
 for(let offset=0;offset<task.ids.length;offset+=100){
  const batch=task.ids.slice(offset,offset+100);
  let result=null;
  for(let attempt=1;attempt<=3;attempt++){
   try{result=await vk.api.messages.getByConversationMessageId({peer_id:task.peer,group_id:groupId,conversation_message_ids:batch.join(',')});break;}
   catch(e){if(attempt===3){peerErrors++;console.log('VK GAP BATCH FAILED',task.peer,offset,String(e?.message||e).slice(0,180));}else await new Promise(r=>setTimeout(r,1000*attempt));}
  }
  if(!result)continue;
  for(const item of result.items||[]){
   const cmid=Number(item.conversation_message_id??0),sender=Number(item.from_id??0),createdAt=Number(item.date??0);
   if(!Number.isSafeInteger(cmid)||cmid<=0||!Number.isFinite(createdAt)||createdAt<=0)continue;
   peerFound++;
   const archived=saveVkMessageArchiveRecord({peerId:task.peer,sourcePeerId:task.peer,conversationMessageId:cmid,messageId:Number(item.id||0),senderId:sender,createdAt,isOutbox:Number(item.out||0)===1,text:String(item.text||''),actionType:String(item.action?.type||''),actionJson:item.action||'',rawMessageJson:item,durableJournal:false});
   if(Number(archived)>0)peerArchived++;
   if(Number(item.out||0)!==1&&Number.isSafeInteger(sender)&&sender!==0){
    const r=saveIncomingMessage({peerId:task.peer,senderId:sender,conversationMessageId:cmid,text:String(item.text||''),createdAt,durableJournal:false});
    if(Number(r?.changes||0)>0)peerIncoming++;
   }
  }
  if(offset===0||((offset/100+1)%10===0)||offset+100>=task.ids.length)
   console.log('VK GAP PROGRESS',JSON.stringify({peer:task.peer,processed:Math.min(task.ids.length,offset+100),total:task.ids.length,found:peerFound,archiveNew:peerArchived,incomingNew:peerIncoming,errors:peerErrors}));
  await new Promise(r=>setTimeout(r,160));
 }
 totalFound+=peerFound;totalArchive+=peerArchived;totalIncoming+=peerIncoming;totalErrors+=peerErrors;
 console.log('VK GAP PEER DONE',JSON.stringify({peer:task.peer,missing:task.missing,found:peerFound,archiveNew:peerArchived,incomingNew:peerIncoming,errors:peerErrors}));
}
console.log('VK GAP BACKFILL DONE',JSON.stringify({days:7,peers:work.length,found:totalFound,archiveNew:totalArchive,incomingNew:totalIncoming,batchErrors:totalErrors}));
if(totalErrors)process.exitCode=1;
