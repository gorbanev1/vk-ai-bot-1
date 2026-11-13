import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRecurringChatWriteCommand as parse,formatRecurringInterval,createRecurringChatWriteService}
 from '../../src/features/routing/recurringChatWrite.js';
test('command supports a second, every three seconds, five minutes, and third of hour',()=>{
 const samples=[
  ['\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432 \u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u0443\u044e \u0441\u0435\u043a\u0443\u043d\u0434\u0443',1000],
  ['\u043f\u0438\u0448\u0438 \u0432 \u0447\u0430\u0442 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 1 \u0441\u0435\u043a\u0443\u043d\u0434\u0443',1000],
  ['\u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 \u0442\u0440\u0438 \u0441\u0435\u043a\u0443\u043d\u0434\u044b',3000],
  ['\u043a\u0430\u0436\u0434\u044b\u0435 3 \u0441\u0435\u043a\u0443\u043d\u0434\u044b \u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442',3000],
  ['\u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 \u043f\u044f\u0442\u044c \u043c\u0438\u043d\u0443\u0442',300000],
  ['\u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 \u043e\u0434\u043d\u0443 \u0442\u0440\u0435\u0442\u044c \u0447\u0430\u0441\u0430',1200000],
  ['\u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 37 \u043c\u0438\u043d\u0443\u0442',2220000],
  ['\u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 7 \u0434\u043d\u0435\u0439',604800000],
 ];
 for(const [phrase,ms] of samples)
  assert.deepEqual(parse(phrase),{action:'create',message:'\u043f\u0440\u0438\u0432\u0435\u0442',intervalMs:ms},phrase);
 assert.equal(parse('\u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 0,5 \u0441\u0435\u043a\u0443\u043d\u0434\u044b').action,'invalid');
 assert.equal(parse('\u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 8 \u0434\u043d\u0435\u0439').action,'invalid');
});
test('unit formatting retains subminute cadence',()=>{
 for(const [interval,label] of [[1000,'1 \u0441\u0435\u043a'],[3000,'3 \u0441\u0435\u043a'],
  [300000,'5 \u043c\u0438\u043d'],[1200000,'20 \u043c\u0438\u043d']])
  assert.equal(formatRecurringInterval(interval),label);
});
test('durable worker delivers one-second schedule without busy catch-up or duplicates',async()=>{
 const root=mkdtempSync(join(tmpdir(),'recurring-1s-')),path=join(root,'state.sqlite');
 let t=1_000_000;const sent=[];
 const scope={platform:'vk',peerId:'2000000006',senderId:'123',endpointKey:'vk:primary'};
 const make=()=>createRecurringChatWriteService({databasePath:path,now:()=>t,send:async x=>sent.push(x),log:{warn(){}}});
 try{
  let worker=make();
  const command=parse('\u043f\u0438\u0448\u0438 \u0442\u0435\u0441\u0442 \u043a\u0430\u0436\u0434\u0443\u044e \u0441\u0435\u043a\u0443\u043d\u0434\u0443');
  worker.create(scope,command);
  assert.equal((await worker.tick()).sent,0);
  t+=999;assert.equal((await worker.tick()).sent,0);
  t+=1;assert.equal((await worker.tick()).sent,1);
  assert.equal((await worker.tick()).sent,0);
  t+=1000;assert.equal((await worker.tick()).sent,1);
  worker.close();worker=make();
  t+=1000;assert.equal((await worker.tick()).sent,1);
  t+=30_000;assert.equal((await worker.tick()).sent,1,'no backlog flood');
  worker.cancelAll(scope);
  t+=1000;assert.equal((await worker.tick()).sent,0);
  worker.close();assert.equal(sent.length,4);
 }finally{rmSync(root,{recursive:true,force:true})}
});
