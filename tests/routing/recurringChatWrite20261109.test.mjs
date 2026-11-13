import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRecurringChatWriteCommand as parse,createRecurringChatWriteService,formatRecurringInterval} from '../../src/features/routing/recurringChatWrite.js';
test('order-independent 4.5 hours command and optional в чат',()=>{
 const cases=['Гигорейв пиши ферма каждые 4,5 часа в чат','пиши каждые 4,5 часа ферма','каждые 4,5 часа пиши ферма','каждые 4 часа 30 минут пиши ферма','пиши ферма раз в 4,5 часа'];
 for(const item of cases)assert.deepEqual(parse(item),{action:'create',message:'ферма',intervalMs:270*60000},item);
 assert.equal(formatRecurringInterval(270*60000),'4 ч 30 мин');
});
test('cancel one, cancel all, show numbered active list; unrelated messages ignored',()=>{
 for(const x of ['Гигорейв не пиши 1','пиши не 1','отмени пиши 1'])assert.equal(parse(x).action,'cancel-one',x);
 for(const x of ['Гигорейв пиши отменить все','отмени все пиши','не пиши все'])assert.equal(parse(x).action,'cancel-all',x);
 for(const x of ['пиши все активные','все активные пиши','пиши список'])assert.equal(parse(x).action,'list',x);
 for(const x of ['Ирис фарма','Куда едете','туса в дизеле'])assert.equal(parse(x),null,x);
 assert.equal(parse('пиши ферма').action,'help');
 assert.equal(parse('пиши ферма каждые 1 минуту').intervalMs,60000);
 assert.equal(parse('пиши @all каждые 4 часа').action,'invalid');
});
test('SQLite retains schedules over restart, duplicates are idempotent, cancellation scoped to chat',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gigorave-recur-test-'));let time=1000000000;const sent=[];
 const open=()=>createRecurringChatWriteService({databasePath:join(dir,'recurring.sqlite'),now:()=>time,send:async x=>sent.push(x),log:{warn(){}}});
 const scope={platform:'vk',peerId:'2000000011',senderId:'111',endpointKey:'vk:primary'};
 const other={...scope,peerId:'2000000010'};
 try{
  let db=open(),c=parse('пиши ферма каждые 4,5 часа');
  assert.equal(db.create(scope,c).index,1);
  assert.equal(db.create(scope,c).existing,true);
  assert.equal(db.list(other).length,0);
  assert.match(db.formatList(scope),/1\. «ферма» — каждые 4 ч 30 мин/u);
  assert.equal((await db.tick()).sent,0);
  db.close();db=open();
  time+=270*60000;
  assert.equal((await db.tick()).sent,1);
  assert.equal(sent[0].text,'ферма');assert.equal(sent[0].peerId,scope.peerId);
  assert.equal((await db.tick()).sent,0);
  db.create(scope,parse('пиши второе каждые 2 часа'));
  assert.equal(db.cancelOne(scope,1).message_text,'ферма');
  assert.equal(db.list(scope).length,1);
  assert.equal(db.cancelAll(other),0);
  assert.equal(db.cancelAll(scope),1);
  assert.equal(db.list(scope).length,0);
  db.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('Telegram thread is distinct; send failures retry after delay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gigorave-recur-failure-'));let time=1000000000,n=0;
 const s=createRecurringChatWriteService({databasePath:join(dir,'recurring.sqlite'),now:()=>time,send:async x=>{n++;if(n===1)throw Error('network');},log:{warn(){}}});
 const scope={platform:'telegram',peerId:'-100444',threadId:'5',senderId:'789'};
 try{
  s.create(scope,parse('пиши фарма каждые 2 часа'));
  assert.equal(s.list({...scope,threadId:'6'}).length,0);
  time+=7200000;
  assert.equal((await s.tick()).failed,1);
  assert.equal((await s.tick()).sent,0);
  time+=300000;assert.equal((await s.tick()).sent,1);
  s.cancelAll(scope);time+=7200000;
  assert.equal((await s.tick()).sent,0);
 }finally{s.close();rmSync(dir,{recursive:true,force:true})}
});
test('production routes pishi commands before model and starts one persistent lightweight timer',()=>{
 const app=readFileSync(process.env.GIGORAVE_STAGED_APP||new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/parseRecurringChatWriteCommand\(candidate\)/u);
 assert.match(app,/recurringChatWrites\.create\(scope,command\)/u);
 assert.match(app,/recurringChatWrites\.cancelOne\(scope,command.index\)/u);
 assert.match(app,/recurringChatWrites\.cancelAll\(scope\)/u);
 assert.match(app,/recurringChatWrites\.formatList\(scope\)/u);
 assert.match(app,/recurringChatWrites\.tick\(\)/u);
 assert.match(app,/if\(await maybeHandleRecurringChatWrite\(context,routingCandidates\)\)return/u);
});
