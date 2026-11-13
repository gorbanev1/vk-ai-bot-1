import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createExtendedRangeApprovalStore} from '../../src/features/events/extendedRangeApproval.js';
import {formatExtendedRangeOwnerRequest,formatExtendedRangeGroupDecision,formatExtendedRangeDecisionAlready} from '../../src/features/events/extendedRangeApprovalDisplay.js';
const DAY=86400000;
const data={platform:'vk',peerId:'2000000006',requesterId:'16296974',
 chatTitle:'Гигорейв чат (Добрый чат)',requesterName:'Денис Солодовников',
 routeMethod:'local',range:{fromDate:'2026-11-13',toDate:'2026-11-30'},
 options:{partyPool:'primary'},allParties:false};
function fixture(fn){
 const root=mkdtempSync(join(tmpdir(),'gig-approval-'));
 let time=Date.parse('2026-11-13T16:14:00Z');
 const open=()=>createExtendedRangeApprovalStore({databasePath:join(root,'decisions.sqlite'),now:()=>time});
 const advance=ms=>time+=ms;
 try{return fn({open,advance,path:join(root,'decisions.sqlite')})}finally{rmSync(root,{recursive:true,force:true})}
}
test('owner request displays human names and conversation title, never raw IDs',()=>{
 const msg=formatExtendedRangeOwnerRequest(data);
 assert(msg.includes('Гигорейв чат (Добрый чат)'));
 assert(msg.includes('Денис Солодовников'));
 assert(!msg.includes('16296974')&&!msg.includes('2000000006'));
 assert(!msg.includes('vk:'));
 const bad=formatExtendedRangeOwnerRequest({...data,chatTitle:'2000000006',requesterName:'vk:16296974'});
 assert.match(bad,/Название беседы недоступно/);
 assert.match(bad,/имя недоступно/);
 assert(!bad.includes('16296974')&&!bad.includes('2000000006'));
});
test('first decision wins across VK and Telegram permanently, and 24-hour expiry is real',()=>{
 fixture(({open})=>{
  const a=open(),b=open();
  const row=a.request(data).record;
  assert.equal(row.expiresAt-row.createdAt,DAY);
  assert.equal(a.decide(row.id,'deny','telegram').ok,true);
  const second=b.decide(row.id,'approve','vk');
  assert.equal(second.ok,false);assert.equal(second.reason,'already-denied');
  assert.equal(a.get(row.id).status,'denied');
  assert.equal(a.get(row.id).decidedChannel,'telegram');
  assert.equal(formatExtendedRangeDecisionAlready(second.record.status),'Уже отказано. Решение окончательное.');
  a.close();b.close();
 });
});
test('new request after same dedupe signature keeps existing pending even if display names change',()=>{
 fixture(({open})=>{
  const store=open();
  const first=store.request(data);
  const second=store.request({...data,chatTitle:'Другое имя беседы',requesterName:'Другой профиль'});
  assert.equal(first.created,true);
  assert.equal(second.created,false);
  assert.equal(second.record.id,first.record.id);
  store.close();
 });
});
test('notification outbox claims exactly once, retries after failure, marks sent only once',()=>{
 fixture(({open,advance})=>{
  const x=open(),y=open(),record=x.request(data).record;
  x.decide(record.id,'deny','vk');
  assert.equal(x.listUnnotified().length,1);
  assert.equal(x.takeNotification(record.id),true);
  assert.equal(y.takeNotification(record.id),false);
  assert.equal(x.notificationFailed(record.id,'Temporary VK timeout'),true);
  assert.equal(x.listUnnotified().length,0);
  advance(61_000);
  assert.equal(y.takeNotification(record.id),true);
  assert.equal(y.notificationSent(record.id),true);
  assert.equal(x.notificationSent(record.id),false);
  assert.equal(x.listUnnotified().length,0);
  assert(x.get(record.id).notificationSentAt>0);
  x.close();y.close();
 });
});
test('approved request cannot deliver until the group is notified; delivery starts once only',()=>{
 fixture(({open})=>{
  const a=open(),b=open(),record=a.request(data).record;
  assert.equal(a.decide(record.id,'approve','telegram').ok,true);
  assert.equal(a.startDelivery(record.id),false);
  assert.equal(a.takeNotification(record.id),true);
  assert.equal(a.notificationSent(record.id),true);
  assert.equal(a.startDelivery(record.id),true);
  assert.equal(b.startDelivery(record.id),false);
  assert.equal(b.decide(record.id,'deny','vk').ok,false);
  assert.equal(b.decide(record.id,'deny','vk').record.status,'delivering');
  assert.equal(a.finish(record.id,'delivered'),true);
  assert.equal(a.finish(record.id,'delivered'),false);
  assert.equal(b.get(record.id).status,'delivered');
  assert.equal(b.decide(record.id,'deny','vk').reason,'already-delivered');
  a.close();b.close();
 });
});
test('backward-compatible SQLite upgrade preserves historical denied decision for notification repair',()=>{
 fixture(({open,path})=>{
  const db=new DatabaseSync(path);
  db.exec("CREATE TABLE extended_party_range_approvals(id TEXT PRIMARY KEY, request_key TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,platform TEXT NOT NULL,peer_id TEXT NOT NULL,requester_id TEXT NOT NULL,request_json TEXT NOT NULL,decided_at INTEGER NOT NULL DEFAULT 0,decided_channel TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '');");
  const when=Date.parse('2026-11-13T16:14:00Z');
  db.prepare('INSERT INTO extended_party_range_approvals(id,request_key,created_at,expires_at,status,platform,peer_id,requester_id,request_json,decided_at,decided_channel) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
   'abcdefabcdefabcdefabcdef','legacy-key',when,when+DAY*24,'denied','vk','2000000006','16296974',JSON.stringify(data),when+3000,'telegram');
  db.close();
  const store=open();
  const old=store.get('abcdefabcdefabcdefabcdef');
  assert.equal(old.status,'denied');
  assert.equal(old.decidedChannel,'telegram');
  assert.equal(store.listUnnotified().length,1);
  assert.equal(store.decide(old.id,'approve','vk').reason,'already-denied');
  store.close();
 });
});
test('status notification for group has clear approval or denial outcome and requester name',()=>{
 const approved=formatExtendedRangeGroupDecision({...data,status:'approved'});
 const denied=formatExtendedRangeGroupDecision({...data,status:'denied'});
 assert.match(approved,/разрешил/);
 assert.match(approved,/Начинаю выдачу событий/);
 assert.match(denied,/отклонил/);
 assert.match(denied,/не будет запущена/);
 assert(approved.includes('Денис Солодовников'));
 assert(denied.includes('Денис Солодовников'));
 assert(!approved.includes('2000000006')&&!denied.includes('16296974'));
});
test('both platforms share one SQLite decision; Telegram callback shows final status without second action',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/if\(record\.status!=='pending'\)/);
 assert.match(app,/formatExtendedRangeDecisionAlready\(record\.status\)/);
 assert.match(app,/source:\{platform:'telegram'/);
 assert.match(app,/source:\{platform:'vk'/);
 assert.match(app,/notifyExtendedRangeDecision\(record\)/);
 assert.match(app,/clearExtendedRangeOwnerApprovalButtons\(record,source\)/);
});
