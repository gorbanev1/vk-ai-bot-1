import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {chtivoPartRandomId} from '../../src/features/chtivo/chtivoDeliveryId.js';
const source=readFileSync(new URL('../../src/features/chtivo/chtivo.js',import.meta.url),'utf8')
.replace(/^import .*;\r?\n/gm,'').replace('const db = new DatabaseSync(MAIN_DATABASE_PATH);','').replace(/export /g,'');
function setup(){
 const db=new DatabaseSync(':memory:'); let clock=Date.parse('2026-10-30T12:00:00+03:00'), sent=[];
 class Clock extends Date {constructor(...args){super(...(args.length?args:[clock]));} static now(){return clock;}}
 const api=runInNewContext(source+'\n({restoreChtivoSchedules,schedulerTick,getProgress,scheduleFollowing,setTransport: t=>schedulerTransport=t})',{
 db,resolve,process,Date:Clock,console,existsSync:()=>false,setTimeout,setInterval:()=>({unref(){}}),
 normalizeChtivoText:s=>s,splitChtivoChapters:s=>[s],
 splitChtivoBody:body=>body.match(/[\s\S]{1,1000}/g)||[],chtivoPartRandomId,
 formatChtivoIntroduction:()=> 'Introduction',resolveChtivoConversationMessageId:async()=>42,
 findLatestChtivoPartConversationMessageId:()=>42,
 });
 db.exec("INSERT INTO chtivo_books(id,catalog_no,title,path,version,created_at) VALUES(1,1,'Book','book.txt','v',0)");
 for(let i=0;i<3;i++)db.prepare("INSERT INTO chtivo_chapters(book_id,chapter_order,title,body,version) VALUES(1,?,?,?,'v')").run(i,'Chapter '+i,'a'.repeat(3500));
 function add(peer,done=1,active=1,chapter=1){
 db.prepare("INSERT INTO chtivo_progress(peer_id,book_id,chapter_order,chapter_completed,active,max_mode,chapter_started_day,updated_at) VALUES(?,1,?,?,?,2,'2026-10-28',?)").run(peer,chapter,done,active,Math.floor(clock/1000)-86400);
 }
 api.setTransport({send:async p=>{sent.push(p);return {conversation_message_id:42};}});
 return {db,api,add,sent,setClock:v=>clock=Date.parse(v),due:()=>db.exec('UPDATE chtivo_schedule SET due_at=0')};
}
test('restart restores all active readers, preserves existing deadlines and skips paused/finished books',()=>{
 const x=setup();try{
 x.add(6);x.add(8);x.add(9,0,0);x.add(10,1,1,3);
 x.api.restoreChtivoSchedules();
 assert.deepEqual(x.db.prepare('SELECT peer_id FROM chtivo_schedule ORDER BY peer_id').all().map(r=>r.peer_id),[6,8]);
 const before=x.db.prepare('SELECT * FROM chtivo_schedule').all();x.api.restoreChtivoSchedules();
 assert.deepEqual(x.db.prepare('SELECT * FROM chtivo_schedule').all(),before);
 assert.equal(x.sent.length,0);
 }finally{x.db.close();}
});
test('next day starts next chapter, respects two regular parts, then schedules tomorrow',async()=>{
 const x=setup();try{
 x.add(6);x.api.restoreChtivoSchedules();x.due();await x.api.schedulerTick();
 assert.equal(x.db.prepare('SELECT COUNT(*) n FROM chtivo_publications').get().n,2);
 let p=x.api.getProgress(6,1);assert.equal(p.chapter_order,1);assert.equal(p.chapter_offset,2000);assert.equal(p.chapter_started_day,'2026-10-30');
 x.due();await x.api.schedulerTick();p=x.api.getProgress(6,1);
 assert.equal(p.chapter_completed,1);assert.equal(p.chapter_order,2);
 const deadline=x.db.prepare('SELECT due_at FROM chtivo_schedule').get().due_at;
 assert.ok(deadline>=Date.parse('2026-10-31T10:00:00+03:00')/1000);
 const count=x.sent.length;x.due();await x.api.schedulerTick();assert.equal(x.sent.length,count);
 x.setClock('2026-10-31T12:00:00+03:00');x.due();await x.api.schedulerTick();
 assert.equal(x.api.getProgress(6,1).chapter_order,2);
 assert.equal(x.db.prepare('SELECT COUNT(*) n FROM chtivo_publications WHERE chapter_order=2').get().n,2);
 }finally{x.db.close();}
});

test('two regular parts may include an additional final tail below 25 percent',async()=>{
 const x=setup();try{
 x.db.prepare('UPDATE chtivo_chapters SET body=? WHERE chapter_order=1').run('a'.repeat(2500));
 x.add(6);x.api.restoreChtivoSchedules();x.due();await x.api.schedulerTick();
 assert.equal(x.db.prepare('SELECT COUNT(*) n FROM chtivo_publications').get().n,3);
 assert.equal(x.api.getProgress(6,1).chapter_completed,1);
 }finally{x.db.close();}
});
