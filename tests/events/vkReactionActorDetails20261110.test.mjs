import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const collector=await import(process.env.GIGORAVE_ACTIVITY_COLLECTOR_STAGED_FILE?pathToFileURL(process.env.GIGORAVE_ACTIVITY_COLLECTOR_STAGED_FILE).href:
 new URL('../../src/features/personality/vkActivityReactions.js',import.meta.url).href);
const stats=await import(process.env.GIGORAVE_ACTIVITY_STATS_STAGED_FILE?pathToFileURL(process.env.GIGORAVE_ACTIVITY_STATS_STAGED_FILE).href:
 new URL('../../src/features/personality/activityStats.js',import.meta.url).href);
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'gigorave-actor-details-')),file=join(dir,'bot.sqlite');
 const db=new DatabaseSync(file);
 db.exec('CREATE TABLE messages(peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,created_at INTEGER);'+
 'CREATE TABLE vk_message_archive(peer_id INTEGER,source_peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,created_at INTEGER,is_outbox INTEGER,action_type TEXT,raw_message_json TEXT);'+
 'CREATE TABLE platform_identities(platform TEXT,entity_type TEXT,external_id TEXT,internal_id INTEGER);'+
 'CREATE TABLE vk_user_name_cache(user_id INTEGER,full_name TEXT);'+
 'CREATE TABLE communication_participants(peer_id INTEGER,user_id INTEGER,display_name TEXT);'+
 'CREATE TABLE auto_summary_settings(peer_id INTEGER,endpoint_key TEXT);');
 const peer=2000000010;
 const add=(cmid,sender,date)=>db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?,?,?)').run(peer,peer,cmid,sender,date,0,'','{}');
 add(1,11,110);add(2,12,111);add(3,13,112);
 return {db,file,peer,close(){db.close();rmSync(dir,{recursive:true,force:true})}};
}
test('VK actor-detail method fills hidden user IDs only for incomplete reaction counters',async()=>{
 const f=fixture();
 try{
  const calls=[],fake={api:{messages:{
   getMessagesReactions:async()=>({items:[
    {cmid:1,counters:[{reaction_id:2,count:3,user_ids:[]}]},
    {cmid:2,counters:[{reaction_id:1,count:1,user_ids:[11]}]}
   ]}),
   getReactedPeers:async({peer_id,cmid})=>{
    calls.push({peer_id,cmid});
    return {count:3,reactions:[
     {user_id:11,reaction_id:2},
     {user_id:12,reaction_id:2},
     {user_id:13,reaction_id:2}
    ]};
   }
  }}};
  const result=await collector.refreshVkActivityReactionsForPlan({
   dbPath:f.file,plan:{startAt:100,snapshotAt:200},clientForPeer:()=>fake,
   logger:{info(){},warn(){}}
  });
  assert.equal(result.actorDetailCalls,1);
  assert.equal(result.actorDetailFailures,0);
  assert.deepEqual(calls,[{peer_id:f.peer,cmid:1}]);
  const report=stats.collectActivity(f.db,{startAt:100,snapshotAt:200})[0];
  const rows=new Map(report.rows.map(x=>[x.id,x]));
  assert.equal(rows.get(11).received,3);
  assert.equal(rows.get(11).given,2); // reacted to both CMID 1 and CMID 2
  assert.equal(rows.get(12).given,1);
  assert.equal(rows.get(13).given,1);
  assert.equal(rows.get(11).givenKnown,true);
  assert.equal(rows.get(12).givenKnown,true);
 }finally{f.close();}
});
test('unavailable actor-details never hides an observed lower bound',async()=>{
 const f=fixture();
 try{
  const fake={api:{messages:{
   getMessagesReactions:async()=>({items:[
    {cmid:1,counters:[{reaction_id:2,count:3,user_ids:[]}]},
    {cmid:2,counters:[{reaction_id:1,count:1,user_ids:[11]}]}
   ]}),
   getReactedPeers:async()=>{throw Error('temporary VK 429');}
  }}};
  const res=await collector.refreshVkActivityReactionsForPlan({
   dbPath:f.file,plan:{startAt:100,snapshotAt:200},clientForPeer:()=>fake,
   logger:{warn(){},info(){}}
  });
  assert.equal(res.actorDetailFailures,1);
  const report=stats.collectActivity(f.db,{startAt:100,snapshotAt:200})[0];
  const row=report.rows.find(x=>x.id===11);
  assert.equal(row.given,1);
  assert.equal(row.givenKnown,false);
  const formatted=stats.formatActivityStats({label:'За день',snapshotAt:200},report.rows);
  assert.match(formatted,/Поставил: ≥1/u);
  assert.match(formatted,/Получил: 3/u);
 }finally{f.close();}
});
