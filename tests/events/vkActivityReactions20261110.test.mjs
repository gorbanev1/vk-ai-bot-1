import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
 VK_ACTIVITY_REACTIONS_SCHEMA,normalizeVkReactionCounters,refreshVkActivityReactionsForPlan
} from '../../src/features/personality/vkActivityReactions.js';
const moduleUrl=process.env.GIGORAVE_ACTIVITY_STATS_STAGED_FILE
 ?pathToFileURL(process.env.GIGORAVE_ACTIVITY_STATS_STAGED_FILE).href
 :new URL('../../src/features/personality/activityStats.js',import.meta.url).href;
const {collectActivity,formatActivityStats}=await import(moduleUrl);
const peer1=2000000010,peer2=2000000011,priorPeer=2000000002;
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'gigorave-reactions-test-'));
 const file=join(dir,'bot.sqlite');
 const db=new DatabaseSync(file);
 db.exec(
  'CREATE TABLE messages(peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,created_at INTEGER);'+
  'CREATE TABLE vk_message_archive(peer_id INTEGER,source_peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,created_at INTEGER,is_outbox INTEGER,action_type TEXT,raw_message_json TEXT);'+
  'CREATE TABLE platform_identities(platform TEXT,entity_type TEXT,external_id TEXT,internal_id INTEGER);'+
  'CREATE TABLE vk_user_name_cache(user_id INTEGER,full_name TEXT);'+
  'CREATE TABLE communication_participants(peer_id INTEGER,user_id INTEGER,display_name TEXT);'+
  'CREATE TABLE auto_summary_settings(peer_id INTEGER,endpoint_key TEXT);'
 );
 const push=(peer,source,cmid,author,date,reactions)=>{
  db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?,?,?)').run(peer,source,cmid,author,date,0,'',JSON.stringify(reactions===undefined?{}:{reactions}));
 };
 return {db,file,push,close:()=>{db.close();rmSync(dir,{recursive:true,force:true})}};
}
test('VK reactions without archive field are restored from official API and counted by actors',async()=>{
 const f=fixture();
 try{
  f.push(peer1,peer1,101,11,110);
  f.push(peer1,peer1,102,12,111);
  f.push(peer1,peer1,103,11,112);
  f.push(peer2,peer2,201,22,120);
  f.push(peer2,peer2,202,23,121);
  const calls=[];
  const fake={
   api:{messages:{getMessagesReactions:async({peer_id,cmids})=>{
    const ids=cmids.split(',').map(Number);
    calls.push([peer_id,ids]);
    const data=peer_id===peer1
      ?[{cmid:101,counters:[{reaction_id:1,count:2,user_ids:[12,15]}]},
        {cmid:103,counters:[{reaction_id:2,count:1,user_ids:[12]}]}]
      :[{cmid:201,counters:[{reaction_id:1,count:1,user_ids:[23]}]}];
    return {items:data.filter(r=>ids.includes(r.cmid))};
   }}}
  };
  const data=await refreshVkActivityReactionsForPlan({
   dbPath:f.file,plan:{startAt:100,snapshotAt:200},clientForPeer:()=>fake,
   logger:{info(){},warn(){}}
  });
  assert.equal(data.peers,2);assert.equal(data.checked,5);
  assert.equal(data.positive,3);assert.equal(data.failures.length,0);
  assert.equal(calls.length,2);
  const reports=collectActivity(f.db,{startAt:100,snapshotAt:200});
  const festival=reports.find(r=>r.peerId===peer1);
  const patrol=reports.find(r=>r.peerId===peer2);
  const row1=new Map(festival.rows.map(r=>[r.id,r]));
  const row2=new Map(patrol.rows.map(r=>[r.id,r]));
  assert.equal(row1.get(11).received,3);assert.equal(row1.get(12).given,2);
  assert.equal(row1.get(12).received,0);
  assert.equal(row2.get(22).received,1);assert.equal(row2.get(23).given,1);
  assert.equal(row1.get(11).receivedKnown,true);assert.equal(row1.get(12).givenKnown,true);
  assert.match(formatActivityStats({label:'за день',snapshotAt:200},festival.rows),/Получил: 3/u);
  const empty=f.db.prepare('SELECT counters_json FROM vk_activity_reaction_snapshots WHERE peer_id=? AND conversation_message_id=102').get(peer1);
  assert.deepEqual(JSON.parse(empty.counters_json),[],'API response without a reaction row represents verified zero');
 }finally{f.close();}
});
test('API failure preserves old snapshots and marks missing data as unknown, never fabricated zero',async()=>{
 const f=fixture();
 try{
  f.push(peer1,peer1,101,11,110);
  f.push(peer1,peer1,102,12,111);
  f.db.exec(VK_ACTIVITY_REACTIONS_SCHEMA);
  f.db.prepare('INSERT INTO vk_activity_reaction_snapshots VALUES(?,?,?,?,?)')
   .run(peer1,101,110,JSON.stringify([{reaction_id:1,count:3,user_ids:[12,15,16]}]),170);
  const log=[];
  const result=await refreshVkActivityReactionsForPlan({
   dbPath:f.file,plan:{startAt:100,snapshotAt:200},
   clientForPeer:()=>({api:{messages:{getMessagesReactions:async()=>{throw Error('VK 429 rate limit')}}}}),
   logger:{warn:(...x)=>log.push(x),info(){}}
  });
  assert.equal(result.failures.length,1);
  const saved=f.db.prepare('SELECT counters_json FROM vk_activity_reaction_snapshots WHERE peer_id=? AND conversation_message_id=101').get(peer1);
  assert.equal(JSON.parse(saved.counters_json)[0].count,3);
  const rows=collectActivity(f.db,{startAt:100,snapshotAt:200})[0].rows;
  assert.equal(rows.find(x=>x.id===11).received,3);
  assert.equal(rows.find(x=>x.id===12).receivedKnown,false);
  assert.equal(rows.find(x=>x.id===12).givenKnown,false);
  assert.ok(log.length);
 }finally{f.close();}
});
test('CMID reused in historical migrated peer does not inflate current reaction count',async()=>{
 const f=fixture();
 try{
  f.push(peer1,priorPeer,101,11,110,[{reaction_id:1,count:1,user_ids:[22]}]);
  f.push(peer1,peer1,101,12,120);
  f.db.exec(VK_ACTIVITY_REACTIONS_SCHEMA);
  f.db.prepare('INSERT INTO vk_activity_reaction_snapshots VALUES(?,?,?,?,?)')
   .run(peer1,101,120,JSON.stringify([{reaction_id:1,count:3,user_ids:[11,22,23]}]),170);
  const rows=collectActivity(f.db,{startAt:100,snapshotAt:200})[0].rows;
  assert.equal(rows.find(x=>x.id===11).received,1);
  assert.equal(rows.find(x=>x.id===12).received,3);
 }finally{f.close();}
});
test('normalized response excludes invalid actor IDs and duplicated IDs',()=>{
 assert.deepEqual(normalizeVkReactionCounters([{reaction_id:1,count:2,user_ids:[22,22,0,-4,'11']}]),
  [{reaction_id:1,count:2,user_ids:[22,11]}]);
 assert.deepEqual(normalizeVkReactionCounters([]),[]);
});
