import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {searchPatrolHistory} from '../../src/features/ai/vkPatrolHistorySearch.js';
const peer=2000000011;
function setup(t){
 const folder=mkdtempSync(join(tmpdir(),'patrol-search-')),databasePath=join(folder,'archive.sqlite');
 const db=new DatabaseSync(databasePath);
 db.exec('CREATE TABLE vk_message_archive(peer_id INTEGER,source_peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,created_at INTEGER,text TEXT)');
 const add=db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?)');
 t.after(()=>{db.close();rmSync(folder,{recursive:true,force:true});});
 return {db,databasePath,add:(id,text,user=7,source=peer)=>add.run(peer,source,id,user,1700000000+id,text),search:args=>searchPatrolHistory(args,{databasePath})};
}
test('search reaches old archive messages, handles Cyrillic case and ё, paginates without repeats',async t=>{
 const f=setup(t);for(let i=1;i<=80;i++)f.add(i,'КОНЦЕРТ Алёны');f.add(81,'КОНЦЕРТ Алёны',7,2000000044);
 const found=[];let offset=0;
 do{const r=await f.search({terms:['концерт','Алены'],match:'all',limit:17,offset});found.push(...r.messages.map(m=>m.cmid));offset=r.nextOffset;if(offset===null)break;}while(offset<1000);
 assert.equal(found.length,80);assert.equal(new Set(found).size,80);assert.equal(found.at(-1),1);assert.ok(!found.includes(81));
});
test('literal wildcard characters, author/date constraints, and exclusion of the request itself',async t=>{
 const f=setup(t);f.add(1,'скидка 20%');f.add(2,'скидка 200');f.add(3,'скидка 20%',8);f.add(4,'скидка 20%');f.add(5,'ищи скидка 20%');
 const r=await f.search({terms:['20%'],senderId:7,afterDate:1700000002,beforeDate:1700000005,excludeCmid:5});
 assert.deepEqual(r.messages.map(m=>m.cmid),[4]);assert.equal(r.totalMatchesKnown,false);
});
test('long search runs outside the main event loop and reports clipped texts',async t=>{
 const f=setup(t);f.db.exec('BEGIN');for(let i=1;i<=12000;i++)f.add(i,'Разговор '.repeat(70));f.add(12001,'Концерт '+'.'.repeat(4000));f.db.exec('COMMIT');
 let ticks=0;const timer=setInterval(()=>ticks++,1);t.after(()=>clearInterval(timer));
 const r=await f.search({terms:['концерт']});clearInterval(timer);
 assert.ok(ticks>0,'main loop must keep responding while the worker scans');assert.equal(r.messages[0].textClipped,true);assert.equal(r.messages[0].text.length,3000);
});
test('worker propagates database errors instead of hanging',async()=>{
 await assert.rejects(searchPatrolHistory({terms:['концерт']},{databasePath:join(tmpdir(),'absent-patrol-db-'+Date.now())}));
});
