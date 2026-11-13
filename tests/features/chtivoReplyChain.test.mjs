import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {chtivoPartRandomId} from '../../src/features/chtivo/chtivoDeliveryId.js';
import {sendChtivoVkMessage} from '../../src/features/chtivo/chtivoVkTransport.js';
import {findLatestChtivoPartConversationMessageId,resolveChtivoConversationMessageId} from '../../src/features/chtivo/chtivoReplyTarget.js';
import {createVkIncomingReplyContext} from '../../src/shared/incomingReplyTransport.js';
const source=readFileSync(new URL('../../src/features/chtivo/chtivo.js',import.meta.url),'utf8')
 .replace(/^import .*;\r?\n/gm,'').replace('const db = new DatabaseSync(MAIN_DATABASE_PATH);','').replace(/export /g,'');
const peer=2000000006;
function setup() {
 const db=new DatabaseSync(':memory:');const sent=[];let id=400,zero=false,fail=false;
 const api={messages:{
  async send(request) {sent.push(request);if(fail)return [{peer_id:peer,error:{error_code:901,error_msg:'Denied'}}];
   return [{peer_id:peer,message_id:0,conversation_message_id:zero?0:++id}];},
  async getById(){throw Error('A direct conversation ID should not need getById');},
 }};
 function runtime() {
  return runInNewContext(source+'\n({publish,getProgress,schedulerTick,setTransport:t=>schedulerTransport=t})',{
   db,resolve,process,console:{log(){},warn(){},error(){}},Date,
   existsSync:()=>false,setTimeout:callback=>callback(),setInterval:()=>({unref(){}}),
   normalizeChtivoText:s=>s,splitChtivoChapters:s=>[s],splitChtivoBody:body=>body.match(/[\s\S]{1,1500}/g)||[],
   chtivoPartRandomId,sendChtivoVkMessage,resolveChtivoConversationMessageId,findLatestChtivoPartConversationMessageId,
   formatChtivoIntroduction:()=> 'Introduction',
  });
 }
 let feature=runtime();
 db.exec("CREATE TABLE vk_message_archive(peer_id INTEGER,conversation_message_id INTEGER,message_id INTEGER,is_outbox INTEGER,text TEXT,created_at INTEGER)");
 db.exec("INSERT INTO chtivo_books(id,catalog_no,title,path,version,created_at) VALUES(1,1,'Book','book.txt','v',0)");
 for(let i=0;i<2;i++)db.prepare("INSERT INTO chtivo_chapters(book_id,chapter_order,title,body,version) VALUES(1,?,?,?,'v')").run(i,'Chapter '+i,'a'.repeat(6800));
 db.prepare("INSERT INTO chtivo_progress(peer_id,book_id,chapter_order,active,max_mode,updated_at) VALUES(?,1,0,1,2,0)").run(peer);
 const context=createVkIncomingReplyContext({peerId:peer,api,conversationMessageId:10,
  send(){throw Error('Reading must use the receipt transport');},reply(){throw Error('Must not reply to the user command');}});
 const book=db.prepare('SELECT * FROM chtivo_books').get();
 return {db,api,context,sent,book,get feature(){return feature;},
  publish:mode=>feature.publish(context,book,feature.getProgress(peer,1),mode),
  restart(){feature=runtime();},zero:v=>zero=v,fail:v=>fail=v,
  parts:()=>sent.filter(r=>/\nЧасть \d+\n\n/.test(r.message)),
  archive(cmid,text){db.prepare('INSERT INTO vk_message_archive VALUES(?,?,0,1,?,?)').run(peer,cmid,text,Math.floor(Date.now()/1000));}
 };
}
function target(request){return request.forward?JSON.parse(request.forward).conversation_message_ids:0;}

test('manual continuation replies to the preceding bot part, not the user or service notice',async()=>{
 const x=setup();try {
  await x.publish(2);const parts=x.parts();
  assert.equal(parts.length,2);assert.equal(target(parts[0]),0);assert.equal(target(parts[1]),401);
  assert.equal(x.feature.getProgress(peer,1).last_text_message_id,403);
  assert.ok(x.sent.every(r=>r.peer_ids[0]===peer&&!('peer_id' in r)));
  await x.publish(1);assert.equal(target(x.parts()[2]),403);
 }finally{x.db.close();}
});
test('scheduled continuation retains the exact bot parent after restart',async()=>{
 const x=setup();try {
  await x.publish(1);x.restart();
  x.feature.setTransport({send:request=>sendChtivoVkMessage(x.api,request)});
  x.db.prepare('INSERT INTO chtivo_schedule VALUES(?,1,0,0)').run(peer);
  await x.feature.schedulerTick();
  assert.equal(target(x.parts()[1]),401);
 }finally{x.db.close();}
});
test('receipt loss saves the sent cursor, stops further parts, and recovers without duplicates',async()=>{
 const x=setup();try {
  x.zero(true);const result=await x.publish(2);
  assert.equal(result.pendingReply,true);assert.equal(x.parts().length,1);
  assert.equal(x.feature.getProgress(peer,1).chapter_offset,1500);
  x.archive(800,x.parts()[0].message);
  for(let i=0;i<110;i++)x.archive(900+i,'Unrelated message '+i);
  x.zero(false);x.restart();await x.publish(1);
  assert.equal(x.parts().length,2);assert.equal(target(x.parts()[1]),800);
  assert.equal(x.db.prepare('SELECT message_id FROM chtivo_publications WHERE part_number=1').get().message_id,800);
 }finally{x.db.close();}
});
test('missing previous part is not replaced by an earlier part of the same chapter',async()=>{
 const x=setup();try {
  await x.publish(2);
  x.db.exec('UPDATE chtivo_progress SET last_text_message_id=0; UPDATE chtivo_publications SET message_id=0');
  x.archive(700,x.parts()[0].message);
  const before=x.sent.length;
  await assert.rejects(x.publish(1),/предыдущей части/);
  assert.equal(x.sent.length,before);
 }finally{x.db.close();}
});
test('publication receipt repairs a lost progress ID even without archive data',async()=>{
 const x=setup();try {
  await x.publish(1);x.db.exec('UPDATE chtivo_progress SET last_text_message_id=0');
  await x.publish(1);assert.equal(target(x.parts()[1]),401);
 }finally{x.db.close();}
});
test('first part of a new chapter does not reply to the preceding chapter',async()=>{
 const x=setup();try {
  x.db.exec('UPDATE chtivo_progress SET chapter_order=1,last_text_message_id=999');
  await x.publish(1);assert.equal(target(x.parts()[0]),0);
 }finally{x.db.close();}
});
test('VK per-peer errors do not advance the reading cursor',async()=>{
 const x=setup();try {
  x.fail(true);await assert.rejects(x.publish(1),/Denied/);
  assert.equal(x.feature.getProgress(peer,1).chapter_offset,0);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM chtivo_publications').get().n,0);
 }finally{x.db.close();}
});
test('the extra short ending follows the second part in the same reply chain',async()=>{
 const x=setup();try {
  x.db.prepare('UPDATE chtivo_chapters SET body=? WHERE chapter_order=0').run('a'.repeat(3600));
  await x.publish(2);assert.equal(x.parts().length,3);
  assert.deepEqual(x.parts().map(target),[0,401,403]);
  assert.equal(x.feature.getProgress(peer,1).chapter_completed,1);
 }finally{x.db.close();}
});
test('transport obtains cmid directly even when global message_id is zero',async()=>{
 let lookups=0;
 const result=await sendChtivoVkMessage({messages:{
  async send(p){assert.deepEqual(p.peer_ids,[peer]);assert.equal(p.random_id,123);return [{peer_id:peer,message_id:0,conversation_message_id:777}];},
  async getById(){lookups++;},
 }},{peerId:peer,message:'Part',replyTo:776,randomId:123});
 assert.equal(result.conversation_message_id,777);assert.equal(lookups,0);
});
test('receipt resolver accepts the single-peer array returned by messages.send',async()=>{
 assert.equal(await resolveChtivoConversationMessageId(null,[{message_id:0,conversation_message_id:777}]),777);
 assert.equal(await resolveChtivoConversationMessageId(null,[{conversation_message_id:1},{conversation_message_id:2}]),0);
});
test('archive recovery verifies part number and body as well as chapter name',()=>{
 const history=[
  {is_outbox:1,conversation_message_id:10,text:'Chapter\nЧасть 3\n\nsame'},
  {is_outbox:1,conversation_message_id:9,text:'Chapter\nЧасть 2\n\ndifferent'},
  {is_outbox:1,conversation_message_id:8,text:'«Wrong book»\nChapter\nЧасть 2\n\nsame'},
  {is_outbox:1,conversation_message_id:7,text:'Chapter\nЧасть 2\n\nsame'},
 ];
 assert.equal(findLatestChtivoPartConversationMessageId(history,'Chapter',{partNumber:2,body:'same',bookTitle:'Book'}),7);
});
