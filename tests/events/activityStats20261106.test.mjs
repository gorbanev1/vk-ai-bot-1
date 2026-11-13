import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {activityPlans,formatActivityStats,plainActivityName,collectActivity,createActivityScheduler} from '../../src/features/personality/activityStats.js';
test('daily and period schedules reuse Moscow calendar boundaries',()=>{
 const check=(date,key)=>assert.ok(activityPlans(new Date(date)).some(p=>p.key.startsWith(key)),date);
 check('2026-11-06T20:55:00Z','day:');check('2026-11-06T11:55:00Z','workweek:');
 check('2026-11-08T16:55:00Z','weekend:');check('2026-11-08T17:55:00Z','full-week:');
 check('2026-12-01T07:55:00Z','calendar-month:');
 assert.equal(activityPlans(new Date('2026-11-06T20:54:59Z')).length,0);
 assert.equal(activityPlans(new Date('2026-11-06T20:57:00Z')).length,0);
 const month=activityPlans(new Date('2026-12-01T07:55:00Z'))[0];
 assert.equal(month.startAt,Date.parse('2026-10-31T21:00:00Z')/1000);
 assert.equal(month.endAt,Date.parse('2026-11-30T21:00:00Z')/1000);
});
test('plain names do not mention people and top is capped at 30',()=>{
 assert.equal(plainActivityName('[id123|Иван] @test **bold**'),'Иван test bold');
 const rows=Array.from({length:35},(_,i)=>({name:'Имя '+i,messages:35-i,givenKnown:false,receivedKnown:false}));
 const text=formatActivityStats({label:'День',snapshotAt:1793998500},rows);
 assert.ok(text.includes('30. Имя 29'));assert.ok(!text.includes('31. Имя'));
 assert.ok(!text.includes('|'));assert.ok(!text.includes('**'));assert.ok(text.includes('Поставил: —'));
});
test('restart and simultaneous ticks cannot duplicate delivery',async()=>{
 let state={},sent=0;
 const deps={now:()=>new Date('2026-11-06T20:55:00Z'),loadState:()=>structuredClone(state),saveState:s=>{state=structuredClone(s)},collect:async()=>[{platform:'vk',externalPeerId:'2000000006',rows:[{name:'Иван',messages:1}]}],send:async()=>{sent++}};
 const scheduler=createActivityScheduler(deps);await Promise.all([scheduler.tick(),scheduler.tick()]);
 await createActivityScheduler(deps).tick();assert.equal(sent,1);
});
test('unknown delivery is not retried as a duplicate',async()=>{
 let state={},sent=0;
 const scheduler=createActivityScheduler({now:()=>new Date('2026-11-06T20:55:00Z'),loadState:()=>state,saveState:s=>{state=s},collect:async()=>[{platform:'vk',externalPeerId:'2000000006',rows:[]}],send:async()=>{sent++;throw Error('timeout')},logger:{error(){}}});
 await scheduler.tick();await scheduler.tick();assert.equal(sent,1);assert.equal(Object.values(state)[0].status,'delivery_unknown');
});
test('counts only period messages and attributes received and given separately',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE messages(peer_id,conversation_message_id,sender_id,created_at); CREATE TABLE vk_message_archive(peer_id,source_peer_id,conversation_message_id,sender_id,created_at,is_outbox,action_type,raw_message_json); CREATE TABLE platform_identities(platform,entity_type,external_id,internal_id); CREATE TABLE vk_user_name_cache(user_id,full_name); CREATE TABLE communication_participants(peer_id,user_id,display_name); CREATE TABLE auto_summary_settings(peer_id,endpoint_key);");
 const peer=2000000006;
 for(const [id,sender,at]of [[1,10,100],[2,10,101],[3,20,102],[4,20,99],[5,20,200]])db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(peer,id,sender,at);
 db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?,?,?)').run(peer,peer,1,10,100,0,'',JSON.stringify({reactions:[{count:2,user_ids:[20,30]}]}));
 const result=collectActivity(db,{startAt:100,snapshotAt:200})[0];
 assert.equal(result.rows[0].id,10);assert.equal(result.rows[0].messages,2);assert.equal(result.rows[0].received,2);assert.equal(result.rows[1].messages,1);assert.equal(result.rows[1].given,1);
 db.close();
});
test('Telegram groups only, anonymous totals do not double-count named reactions',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE messages(peer_id,conversation_message_id,sender_id,created_at); CREATE TABLE vk_message_archive(peer_id,source_peer_id,conversation_message_id,sender_id,created_at,is_outbox,action_type,raw_message_json); CREATE TABLE platform_identities(platform,entity_type,external_id,internal_id); CREATE TABLE vk_user_name_cache(user_id,full_name); CREATE TABLE communication_participants(peer_id,user_id,display_name); CREATE TABLE auto_summary_settings(peer_id,endpoint_key); CREATE TABLE activity_reaction_snapshots(peer_id,message_id,actor_id,reaction_count,updated_at);");
 db.exec("INSERT INTO platform_identities VALUES('telegram','peer','supergroup:-100555',8000000001),('telegram','peer','private:555',8000000002); INSERT INTO messages VALUES(8000000001,1,10,110),(8000000001,2,20,120),(8000000002,1,10,110); INSERT INTO activity_reaction_snapshots VALUES(8000000001,1,20,1,130),(8000000001,1,0,3,130);");
 const result=collectActivity(db,{startAt:100,snapshotAt:200});
 assert.equal(result.length,1);assert.equal(result[0].platform,'telegram');assert.equal(result[0].rows.find(r=>r.id===10).received,3);assert.equal(result[0].rows.find(r=>r.id===20).given,1);
 db.close();
});
