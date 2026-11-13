import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVkIncomingReplyContext} from '../../src/shared/incomingReplyTransport.js';
import {createPatrolTaskMemory} from '../../src/features/ai/vkPatrolTaskMemory.js';
test('successful real transport result is persisted, rejected sends are not recorded',async t=>{
 const folder=mkdtempSync(join(tmpdir(),'patrol-delivery-'));const m=createPatrolTaskMemory({databasePath:join(folder,'memory.sqlite')});
 t.after(()=>{m.close();rmSync(folder,{recursive:true,force:true});});
 const first=m.begin({peer:2000000011,user:7,cmid:10,input:'Запрос'});
 const ctx=createVkIncomingReplyContext({peerId:2000000011,reply:async payload=>{
  if(payload==='fail')throw Error('upload failed');return {conversation_message_id:11,message_id:99};
 }},(payload,result)=>m.output(first.turnId,payload,result));
 assert.equal((await ctx.send('Отправленный результат')).conversation_message_id,11);
 await assert.rejects(ctx.send('fail'));
 const next=m.begin({peer:2000000011,user:7,cmid:12,input:'Поправь',reply:{conversation_message_id:11}});
 const state=m.context(next.turnId);assert.equal(next.taskId,first.taskId);assert.equal(state.turns[0].outputs.length,1);assert.equal(state.turns[0].outputs[0].messageId,99);
});
