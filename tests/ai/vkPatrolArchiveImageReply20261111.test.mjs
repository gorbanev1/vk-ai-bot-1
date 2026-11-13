import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadPatrolConversationContext} from '../../src/features/ai/vkPatrolConversationContext.js';
import {runPatrolInvestigationTool} from '../../src/features/ai/vkPatrolInvestigationTools.js';
import {PATROL_PEER_ID} from '../../src/features/ai/vkPatrolAdaptive.js';
import {authorizePatrolAction,shouldReviewPatrolAnswer} from '../../src/features/ai/vkPatrolCapabilityPolicy.js';
test('archive preserves a bot-authored photo in complete reply thread',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'patrol-vision-')),file=join(dir,'test.sqlite'),db=new DatabaseSync(file);
 try{
  db.exec('CREATE TABLE vk_message_archive(peer_id INTEGER,source_peer_id INTEGER,conversation_message_id INTEGER,message_id INTEGER,sender_id INTEGER,created_at INTEGER,is_outbox INTEGER,text TEXT,action_type TEXT,action_json TEXT,raw_message_json TEXT,first_seen_at INTEGER,updated_at INTEGER)');
  const photo={type:'photo',photo:{id:123,sizes:[{url:'https://sun9.vkuserphoto.ru/safe.jpg',width:1200,height:900}]}};
  const original={conversation_message_id:111,from_id:-233007447,date:1794423741,text:'Bot summary',attachments:[photo]};
  const current={conversation_message_id:112,from_id:1129371915,date:1794424146,text:'Why 7 fingers in the picture?',reply_message:original};
  for(const [cmid,sender,time,obj] of [[111,-233007447,1794423741,original],[112,1129371915,1794424146,current]])
   db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(PATROL_PEER_ID,PATROL_PEER_ID,cmid,0,sender,time,sender<0?1:0,obj.text,'','',JSON.stringify(obj),time,time);
  db.close();
  const chain=await loadPatrolConversationContext({databasePath:file,peerId:PATROL_PEER_ID,currentMessage:current,recentCount:50,maxDepth:20,maxRemoteCalls:0});
  assert.equal(chain.chainComplete,true);
  assert.equal(chain.thread[0].cmid,111);
  assert.equal(chain.thread[0].attachments[0].type,'photo');
  const actual=runPatrolInvestigationTool('message_context',{cmid:111,radius:1},{databasePath:file});
  assert.equal(actual.messages.find(x=>x.cmid===111)?.photos?.[0]?.photoId,123);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('Luna Vision exists as an allowed and reviewable tool, called on original reply image',()=>{
 assert.equal(authorizePatrolAction('inspect_image').ok,true);
 assert.equal(shouldReviewPatrolAnswer([{action:'inspect_image',result:{verifiedImage:true,visualAnalysis:'photo'}}]),true);
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 for(const re of [/async function inspectPatrolArchiveVision/u,
   /const repliedPhoto=visualQuery\?/u,
   /inspectPatrolArchiveVision\(repliedPhoto\.cmid,0,question\)/u,
   /if\(action==='inspect_image'\)/u,/imageUrls:\[bytes\]/u,
   /generateOpenAIVisionText\(\{/u])
  assert.match(app,re);
});
