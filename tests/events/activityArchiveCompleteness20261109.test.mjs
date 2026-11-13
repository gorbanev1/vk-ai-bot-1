import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {collectActivity,formatActivityStats} from '../../src/features/personality/activityStats.js';

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(
  'CREATE TABLE messages(peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,created_at INTEGER);'+
  'CREATE TABLE vk_message_archive(peer_id INTEGER,source_peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,created_at INTEGER,is_outbox INTEGER,action_type TEXT,raw_message_json TEXT);'+
  'CREATE TABLE platform_identities(platform TEXT,entity_type TEXT,external_id TEXT,internal_id INTEGER);'+
  'CREATE TABLE vk_user_name_cache(user_id INTEGER,full_name TEXT);'+
  'CREATE TABLE communication_participants(peer_id INTEGER,user_id INTEGER,display_name TEXT);'+
  'CREATE TABLE auto_summary_settings(peer_id INTEGER,endpoint_key TEXT);'
 );
 return db;
}
const peer=2000000006, oldPeer=2000000002;
const insertArchive=(db,source,cmid,sender,createdAt,{outbox=0,action='',reactions}={})=>
 db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?,?,?)').run(peer,source,cmid,sender,createdAt,outbox,action,JSON.stringify({reactions}));
const insertLive=(db,cmid,sender,time)=>db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(peer,cmid,sender,time);

test('VK archive is authoritative, migrated overlapping CMIDs remain two distinct messages, and live fallback is counted once',()=>{
 const db=fixture();
 try{
  insertArchive(db,peer,100,10,110,{reactions:[{count:3,user_ids:[20,30]}]});
  insertArchive(db,oldPeer,100,20,111,{reactions:[{count:1,user_ids:[10]}]});
  insertArchive(db,peer,101,10,115);
  insertArchive(db,peer,102,-123,117,{outbox:1});
  insertArchive(db,peer,103,10,118,{action:'chat_kick_user'});
  insertLive(db,100,10,110); // same native source/cmid/time = duplicate
  insertLive(db,100,20,111); // migrated legacy copy (different sourcePeerId) is also a duplicate
  insertLive(db,200,30,116); // received live but not archived
  insertArchive(db,peer,105,40,200); // outside interval
  const rows=collectActivity(db,{startAt:100,snapshotAt:200});
  assert.equal(rows.length,1,'chat discovered through archive, not only live messages');
  const stats=new Map(rows[0].rows.map(r=>[r.id,r]));
  assert.equal(stats.get(10).messages,2);
  assert.equal(stats.get(20).messages,1,'migrated chat entry with reused CMID still counts');
  assert.equal(stats.get(30).messages,1,'unarchived live message is not dropped');
  assert.equal(stats.has(-123),false,'bot excluded');
  assert.equal(stats.has(40),false,'end boundary exclusive');
  assert.equal(stats.get(10).received,3);
  assert.equal(stats.get(20).given,1);
  assert.equal(stats.get(10).given,1);
  assert.match(formatActivityStats({label:'За день',snapshotAt:200},rows[0].rows),/Сообщений: 2/u);
 }finally{db.close()}
});

test('VK archive-only chat is included even when messages table has no entries for the period',()=>{
 const db=fixture();
 try{
  insertArchive(db,peer,208919,10,110);
  insertArchive(db,peer,208920,10,111);
  const results=collectActivity(db,{startAt:100,snapshotAt:200});
  assert.equal(results.length,1);
  assert.equal(results[0].rows[0].messages,2);
 }finally{db.close()}
});

test('a duplicated CMID from migrated peer does not multiply live messages in a different period',()=>{
 const db=fixture();
 try{
  insertArchive(db,oldPeer,555,10,105);
  insertArchive(db,peer,555,20,180);
  insertLive(db,555,20,180);
  const rows=collectActivity(db,{startAt:150,snapshotAt:200})[0].rows;
  assert.deepEqual(rows.map(x=>[x.id,x.messages]),[[20,1]]);
 }finally{db.close()}
});
