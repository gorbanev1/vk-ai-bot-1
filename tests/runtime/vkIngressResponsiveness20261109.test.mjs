import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appendDurableJournalAsync,flushDurableJournalWrites,getPendingDurableJournalWrites} from '../../src/infrastructure/database/durableJournalQueue.js';
import {isLikelyInteractiveVkIncoming} from '../../src/features/routing/vkIngressPriority.js';
import {measureSynchronousStage,recordVkIngressDispatch} from '../../src/runtime/eventLoopResponsiveness.js';

test('parallel journal submissions are serialized without losing records or order',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gigorave-async-journal-'));
 try{
  const p=join(dir,'live.jsonl');
  const writes=Array.from({length:120},(_,i)=>appendDurableJournalAsync(p,{peerId:2000000006,cmid:i+1,text:'Сообщение '+i}));
  assert.ok(getPendingDurableJournalWrites()>=1);
  const results=await Promise.all(writes);
  await flushDurableJournalWrites();
  assert.equal(results.every(Boolean),true);
  const rows=readFileSync(p,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,120);
  assert.deepEqual(rows.map(x=>x.cmid),Array.from({length:120},(_,i)=>i+1));
  assert.equal(getPendingDurableJournalWrites(),0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('journals of different kinds write independently; failed journal does not deadlock later writes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gigorave-async-journal-recover-'));
 try{
  const first=join(dir,'first.jsonl'),second=join(dir,'second.jsonl'),bad=join(dir,'missing','journal.jsonl');
  const ok=await Promise.all([appendDurableJournalAsync(first,{n:1}),appendDurableJournalAsync(second,{n:2})]);
  assert.deepEqual(ok,[true,true]);
  assert.equal(await appendDurableJournalAsync(bad,{n:1}),false);
  const result=await appendDurableJournalAsync(first,{n:3});
  assert.equal(result,true);
  await flushDurableJournalWrites();
  assert.deepEqual(readFileSync(first,'utf8').trim().split('\n').map(JSON.parse).map(x=>x.n),[1,3]);
  assert.equal(getPendingDurableJournalWrites(),0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('regular VK chat is not a supervised user request, but all essential commands still are',()=>{
 const base={peerId:2000000006};
 for(const txt of ['давай завтра встретимся','как дела народ','Ирис фарма','👋',''])assert.equal(isLikelyInteractiveVkIncoming({...base,text:txt}),false,txt);
 for(const txt of ['Гигорейв какие команды есть','тусы ноября кратко','статистика','парсер кутикетс все новые','авторезюме выкл','досье Олег','а на выходных?','прожарь Олега']){
  assert.equal(isLikelyInteractiveVkIncoming({...base,text:txt}),true,txt);
 }
 assert.equal(isLikelyInteractiveVkIncoming({...base,text:'ага',replySenderId:-123}),true);
 assert.equal(isLikelyInteractiveVkIncoming({peerId:778899,text:'привет'}),true);
 assert.equal(isLikelyInteractiveVkIncoming({...base,attachments:[{type:'audio_message'}]}),true);
});
test('sync timing does not alter result or errors',()=>{
 recordVkIngressDispatch(3,{interactive:true});
 assert.equal(measureSynchronousStage('test',()=>42),42);
 assert.throws(()=>measureSynchronousStage('test',()=>{throw Error('preserved')}),/preserved/u);
});
test('production awaits ordered durable write before routing and leaves full command supervision',()=>{
 const app=readFileSync(process.env.GIGORAVE_PENDING_APP_PATH||new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const db=readFileSync(process.env.GIGORAVE_PENDING_DB_PATH||new URL('../../src/infrastructure/database/index.js',import.meta.url),'utf8');
 assert.ok(/await saveIncomingMessageAsync\(\{/u.test(app),'contract 1: app');
 assert.ok(/await archiveVkMessageFromMessageLive\(/u.test(app),'contract 2: app');
 assert.ok(/const interactive=isLikelyInteractiveVkIncoming\(/u.test(app),'contract 3: app');
 assert.ok(/if\(!interactive\)return handleVkIncomingMessageCore\(incomingContext\)/u.test(app),'contract 4: app');
 assert.ok(/startEventLoopResponsivenessMonitor\(\)/u.test(app),'contract 5: app');
 assert.ok(/createPriorityIngressScheduler\(/u.test(app),'contract 6: app');
 assert.ok(/await appendDurableJournalAsync\(liveMessageJournalPath/u.test(db),'contract 7: db');
 assert.ok(/await appendDurableJournalAsync\(vkMessageArchiveJournalPath/u.test(db),'contract 8: db');
 assert.ok(/saveIncomingMessage\(\{\.\.\.entry,durableJournal:false\}\)/u.test(db),'async journal is acknowledged and legacy SQLite delegate never double-journals');
});
test('long-block logging uses the existing delay histogram without a per-millisecond probe timer',()=>{
 const source=readFileSync(new URL('../../src/runtime/eventLoopResponsiveness.js',import.meta.url),'utf8');
 assert.match(source,/const LONG_BLOCK_THRESHOLD_MS=2000/u);
 assert.match(source,/eventLoopMaxMs>=LONG_BLOCK_THRESHOLD_MS/u);
 assert.doesNotMatch(source,/setTimeout\s*\(/u);
});
