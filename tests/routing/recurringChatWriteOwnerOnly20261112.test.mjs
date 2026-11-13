import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRecurringChatWriteService} from '../../src/features/routing/recurringChatWrite.js';
import {runPatrolRecurringTool} from '../../src/features/ai/vkPatrolRecurringTool.js';
test('existing non-owner writes are disabled without touching owner jobs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'owner-recurring-'));
 const databasePath=join(root,'jobs.sqlite');
 const own={platform:'vk',peerId:'2000000011',senderId:'755496806'};
 const other={...own,senderId:'335735446'};
 let now=1000000,sends=0;
 try{
  const seeded=createRecurringChatWriteService({databasePath,now:()=>now,send:async()=>{}});
  assert.equal(seeded.create(other,{action:'create',message:'test',intervalMs:1000}).created,true);
  assert.equal(seeded.create(own,{action:'create',message:'owner',intervalMs:1000}).created,true);
  seeded.close();
  const service=createRecurringChatWriteService({
   databasePath,now:()=>now,send:async()=>{sends++},
   allowedCreators:{vk:'755496806',telegram:'8019356616'},log:{warn(){}},
  });
  try{
   assert.equal(service.cancelledUnauthorized,1);
   assert.equal(service.list(own).length,1);
   assert.equal(service.list(other).length,0);
   assert.equal(service.create(other,{action:'create',message:'not allowed',intervalMs:1000}).error,'forbidden');
   assert.equal(service.cancelAll(other),0);
   assert.equal(service.cancelOne(other,1),null);
   assert.equal(runPatrolRecurringTool({originalQuestion:'Гигорейв пиши активные',
    scope:other,service,ownerAuthorized:false}).ok,false);
   assert.equal(runPatrolRecurringTool({originalQuestion:'Гигорейв пиши активные',
    scope:own,service,ownerAuthorized:true}).ok,true);
   now+=1001;
   assert.equal((await service.tick()).sent,1);
   assert.equal(sends,1);
  }finally{service.close()}
  const db=new DatabaseSync(databasePath);
  const rows=db.prepare('SELECT creator_id,active FROM recurring_chat_writes ORDER BY id').all();
  assert.deepEqual(rows.map(x=>[x.creator_id,x.active]),[
   ['335735446',0],['755496806',1],
  ]);
  db.close();
 }finally{rmSync(root,{recursive:true,force:true})}
});
