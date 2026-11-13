import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PATROL_PEER_ID,patrolRequestTokenRemaining,PATROL_REQUEST_TOKEN_LIMIT,
 patrolLogObservation,runPatrolScopedRequest} from '../../src/features/ai/vkPatrolAdaptive.js';
import {runPatrolInvestigationTool,PATROL_INVESTIGATION_ACTIONS}
 from '../../src/features/ai/vkPatrolInvestigationTools.js';
import {authorizePatrolAction} from '../../src/features/ai/vkPatrolCapabilityPolicy.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'patrol-capabilities-'));
 const dbPath=join(root,'demo.sqlite'),db=new DatabaseSync(dbPath);
 db.exec('CREATE TABLE vk_message_archive(peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,created_at INTEGER,text TEXT,raw_message_json TEXT)');
 db.exec('CREATE TABLE vk_chat_source_messages(peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,raw_text TEXT)');
 const raw=JSON.stringify({conversation_message_id:33,from_id:111,attachments:[
  {type:'photo',photo:{id:123,sizes:[{url:'https://sun9.vkuserphoto.ru/safe.jpg',width:1200,height:900}]}}]});
 db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?)')
  .run(PATROL_PEER_ID,32,111,1794400000,'Это я на фото','{}');
 db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?)')
  .run(PATROL_PEER_ID,33,111,1794400030,'Наше фото',raw);
 db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?)')
  .run(PATROL_PEER_ID+1,33,999,1794400020,'Other private chat',raw);
 db.prepare('INSERT INTO vk_chat_source_messages VALUES(?,?,?,?)')
  .run(PATROL_PEER_ID,33,111,'Some event');
 db.close();
 return {root,dbPath};
}
test('runtime allows reading data with typed tools, never arbitrary SQL, with peer isolation',()=>{
 const x=fixture();
 try{
  for(const name of PATROL_INVESTIGATION_ACTIONS)
   assert.equal(authorizePatrolAction(name).ok,true,name);
  const tools=(action,args={})=>runPatrolInvestigationTool(action,args,{databasePath:x.dbPath});
  const catalog=tools('db_catalog');
  assert.ok(catalog.tables.some(t=>t.name==='vk_message_archive'));
  const rows=tools('db_query',{table:'vk_message_archive',fields:['conversation_message_id','text'],limit:20});
  assert.equal(rows.count,2);
  assert.equal(rows.rows.some(x=>x.text==='Other private chat'),false);
  assert.throws(()=>tools('db_query',{table:'sqlite_master'}),/permitted/);
  assert.throws(()=>tools('db_query',{table:'vk_message_archive',fields:['text; DROP TABLE X']}),/column/);
  assert.throws(()=>tools('db_query',{table:'vk_message_archive',filters:[{column:'text',op:'delete',value:'x'}]}),/operator/);
  assert.equal(tools('db_query',{table:'vk_message_archive',filters:[{column:'text',op:'contains',value:'фото'}]}).count,2);
  const photos=tools('search_photos',{includeContext:true,senderId:111});
  assert.equal(photos.photos.length,1);
  assert.equal(photos.photos[0].cmid,33);
  assert.equal(photos.photos[0].nearby.some(x=>x.text==='Это я на фото'),true);
  assert.equal(tools('message_context',{cmid:33,radius:2}).messages.length,2);
  assert.equal(tools('message_context',{cmid:33,radius:2}).messages.some(x=>x.text==='Other private chat'),false);
  const db=new DatabaseSync(x.dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vk_message_archive').get().n,3);
  const corrupt=JSON.stringify({conversation_message_id:33,from_id:999,attachments:[
   {type:'photo',photo:{id:456,sizes:[{url:'https://vkuserphoto.ru/other.jpg'}]}}]});
  db.prepare('UPDATE vk_message_archive SET raw_message_json=? WHERE peer_id=? AND conversation_message_id=?')
   .run(corrupt,PATROL_PEER_ID,33);
  db.close();
  assert.equal(tools('search_photos',{senderId:111}).photos.length,0,
   'corrupted archived JSON cannot assign another person photo to this sender');
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('request budget has 300000-token ceiling and checkpoint trace on tool observations',async()=>{
 assert.equal(PATROL_REQUEST_TOKEN_LIMIT,300000);
 const scope=await runPatrolScopedRequest('budget-tool-tests',async()=>{
  assert.equal(patrolRequestTokenRemaining(),300000);
  patrolLogObservation({action:'db_catalog',args:{},result:{tables:5}});
  return 'ok';
 });
 assert.equal(scope.allowed,true);
 assert.equal(scope.result,'ok');
});
test('developer is last resort and existing isolated module execution is restored',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 for(const action of ['write_module','run_module','delete_module'])
  assert.equal(authorizePatrolAction(action).ok,true);
 assert.match(app,/if\(action==='write_module'\)/u);
 assert.match(app,/if\(action==='run_module'\)/u);
 assert.match(app,/runPatrolInvestigationTool\(action,/u);
 assert.match(app,/patrolRequestTokenRemaining\(/u);
 assert.match(app,/patrolLogObservation\(/u);
 assert.match(app,/ONLY IF existing functions cannot satisfy/u);
 assert.match(app,/create_image_from_photos/u);
});
