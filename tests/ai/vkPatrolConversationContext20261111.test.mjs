import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {loadPatrolConversationContext,formatPatrolConversationContext} from '../../src/features/ai/vkPatrolConversationContext.js';
import {PATROL_PEER_ID,isPatrolPeer} from '../../src/features/ai/vkPatrolAdaptive.js';
import {startLocalQwenAnnouncementAudit} from '../../src/features/events/localQwenEventModels.js';
const peer=2000000011;
const msg=(id,parent=0)=>({
 peer_id:peer,conversation_message_id:id,id:1000+id,from_id:200+id%10,
 date:1700000000+id,text:'message '+id,
 ...(parent?{reply_message:{peer_id:peer,conversation_message_id:parent,id:1000+parent,
  from_id:200+parent%10}}:{})
});
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'patrol-ancestry-')),databasePath=join(dir,'test.sqlite');
 const db=new DatabaseSync(databasePath);
 db.exec('CREATE TABLE vk_message_archive (peer_id INTEGER,source_peer_id INTEGER,conversation_message_id INTEGER,message_id INTEGER,sender_id INTEGER,text TEXT,created_at INTEGER,raw_message_json TEXT)');
 const insert=db.prepare('INSERT INTO vk_message_archive VALUES (?,?,?,?,?,?,?,?)');
 for(let id=1;id<=130;id++){
  const m=msg(id,id-1);
  insert.run(peer,peer,id,m.id,m.from_id,m.text,m.date,JSON.stringify(m));
 }
 const foreign={...msg(129,128),text:'OTHER PEER'};
 insert.run(peer,2000000002,129,foreign.id,foreign.from_id,foreign.text,foreign.date,JSON.stringify(foreign));
 return {dir,databasePath,db};
}
const clean=x=>{try{x.db.close()}catch{}rmSync(x.dir,{recursive:true,force:true})};
test('target conversation strictly isolated',async()=>{
 assert.equal(PATROL_PEER_ID,peer);
 assert.equal(isPatrolPeer(2000000038),false);
 const f=setup();
 try{
  await assert.rejects(loadPatrolConversationContext({
   databasePath:f.databasePath,peerId:2000000038,currentMessage:msg(130,129)
  }),/restricted/u);
 }finally{clean(f)}
});
test('50 messages and full reply chain of 130 messages until root',async()=>{
 const f=setup();
 try{
  const x=await loadPatrolConversationContext({
   databasePath:f.databasePath,peerId:peer,currentMessage:msg(130,129),
   remoteByCmid:async()=>{throw new Error('No remote call needed')}
  });
  assert.equal(x.contextMessageCount,50);
  assert.equal(x.recent.at(0).cmid,81);
  assert.equal(x.recent.at(-1).cmid,130);
  assert.ok(x.recent.every(m=>!m.text.includes('OTHER PEER')));
  assert.equal(x.thread.length,130);
  assert.equal(x.replyDepth,129);
  assert.equal(x.rootCmid,1);
  assert.equal(x.chainComplete,true);
  assert.equal(x.chainStatus,'verified-root');
  assert.equal(x.remoteFetches,0);
  assert.match(formatPatrolConversationContext(x),/message 1/u);
 }finally{clean(f)}
});
test('remote recovery continues beyond missing ancestor to original root',async()=>{
 const f=setup();
 try{
  f.db.prepare('DELETE FROM vk_message_archive WHERE source_peer_id=? AND conversation_message_id=?').run(peer,65);
  let called=0;
  const x=await loadPatrolConversationContext({
   databasePath:f.databasePath,peerId:peer,currentMessage:msg(130,129),
   remoteByCmid:async cmid=>{called++;return cmid===65?msg(65,64):null},
  });
  assert.equal(called,1);
  assert.equal(x.remoteFetches,1);
  assert.equal(x.chainComplete,true);
  assert.equal(x.rootCmid,1);
 }finally{clean(f)}
});
test('missing ancestor is reported rather than invented',async()=>{
 const f=setup();
 try{
  f.db.prepare('DELETE FROM vk_message_archive WHERE source_peer_id=? AND conversation_message_id=?').run(peer,65);
  const x=await loadPatrolConversationContext({
   databasePath:f.databasePath,peerId:peer,currentMessage:msg(130,129),remoteByCmid:async()=>null
  });
  assert.equal(x.chainComplete,false);
  assert.equal(x.chainStatus,'unverified-parent-no-link');
  assert.equal(x.rootCmid,null);
  assert.equal(x.missingReference.cmid,65);
 }finally{clean(f)}
});
test('historical VK reply with foreign peer tag is followed only when author and timestamp match local message',async()=>{
 const f=setup();
 try{
  const child=msg(130,129);
  child.reply_message.peer_id=2000000132;
  child.reply_message.date=1700000000+129;
  const x=await loadPatrolConversationContext({
   databasePath:f.databasePath,peerId:peer,currentMessage:child,
   remoteByCmid:async()=>{throw new Error('local archive should suffice')},
  });
  assert.equal(x.chainComplete,true);
  assert.equal(x.chainStatus,'verified-root');
  assert.equal(x.thread.length,130);
  assert.equal(x.rootCmid,1);
  assert.equal(x.thread.at(-2).source,'verified-foreign-peer+archive');
  assert.equal(x.thread.at(-2).originalReplyPeerId,2000000132);
 }finally{clean(f)}
});
test('historical VK reply with mismatched parent author is not linked to a different chat',async()=>{
 const f=setup();
 try{
  const child=msg(130,129);
  child.reply_message.peer_id=2000000132;
  child.reply_message.date=1700000000+129;
  child.reply_message.from_id=999999;
  const x=await loadPatrolConversationContext({
   databasePath:f.databasePath,peerId:peer,currentMessage:child,
   remoteByCmid:async()=>{throw new Error('must not fetch unverified cross-peer parent')},
  });
  assert.equal(x.chainComplete,false);
  assert.equal(x.chainStatus,'cross-peer-parent');
  assert.equal(x.rootCmid,null);
  assert.equal(x.thread.length,1);
  assert.equal(x.missingReference.cmid,129);
 }finally{clean(f)}
});
test('corrupted historical JSON cannot authenticate unrelated reply chain',async()=>{
 const f=setup();
 try{
  const poisoned=msg(129,128);
  poisoned.from_id=999999;
  poisoned.date=1700000222;
  f.db.prepare('UPDATE vk_message_archive SET raw_message_json=? WHERE peer_id=? AND source_peer_id=? AND conversation_message_id=?')
   .run(JSON.stringify(poisoned),peer,peer,129);
  const child=msg(130,129);
  child.reply_message.peer_id=2000000132;
  child.reply_message.date=1700000000+129;
  const x=await loadPatrolConversationContext({
   databasePath:f.databasePath,peerId:peer,currentMessage:child,maxRemoteCalls:0});
  assert.equal(x.chainComplete,false);
  assert.equal(x.chainStatus,'archive-raw-identity-mismatch');
  assert.equal(x.rootCmid,null);
  assert.equal(x.thread.length,2);
  assert.equal(x.missingReference.cmid,129);
 }finally{clean(f)}
});
test('Qwen historical batch disabled without explicit operator opt-in',()=>{
 const v=process.env.LOCAL_QWEN_EVENT_AUDIT_ENABLED;
 delete process.env.LOCAL_QWEN_EVENT_AUDIT_ENABLED;
 try{assert.equal(startLocalQwenAnnouncementAudit({root:'/unused',logger:{log:()=>{}}}),null)}
 finally{if(v===undefined)delete process.env.LOCAL_QWEN_EVENT_AUDIT_ENABLED;
   else process.env.LOCAL_QWEN_EVENT_AUDIT_ENABLED=v}
});

test('foreign-tagged reply missing locally is verified once through current chat and retains its ancestry',async()=>{
 const f=setup();try{
  f.db.prepare('DELETE FROM vk_message_archive WHERE conversation_message_id=129').run();
  const child=msg(130,129);child.reply_message={...msg(129),peer_id:2000000044};
  let calls=0;const x=await loadPatrolConversationContext({databasePath:f.databasePath,currentMessage:child,maxRemoteCalls:1,
   remoteByCmid:async id=>{calls++;assert.equal(id,129);return msg(129,128);}});
  assert.equal(calls,1);assert.equal(x.chainComplete,true);assert.equal(x.rootCmid,1);assert.equal(x.replyDepth,129);
 }finally{clean(f)}
});
test('foreign reference cannot be authenticated by another peer or a mismatching timestamp',async()=>{
 const f=setup();try{
  f.db.prepare('DELETE FROM vk_message_archive WHERE conversation_message_id=129').run();
  const child=msg(130,129);child.reply_message={...msg(129),peer_id:2000000044};
  for(const remote of [{...msg(129),peer_id:2000000044},{...msg(129),date:123}]){
   const x=await loadPatrolConversationContext({databasePath:f.databasePath,currentMessage:child,remoteByCmid:async()=>remote});
   assert.equal(x.chainComplete,false);assert.equal(x.chainStatus,'cross-peer-parent');assert.equal(x.thread.length,1);
  }
 }finally{clean(f)}
});
