import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPatrolTaskMemory} from '../../src/features/ai/vkPatrolTaskMemory.js';
const peer=2000000011;
function fixture(t){const folder=mkdtempSync(join(tmpdir(),'patrol-memory-'));const path=join(folder,'memory.sqlite');let now=1000;let m=createPatrolTaskMemory({databasePath:path,now:()=>++now});t.after(()=>{m.close();rmSync(folder,{recursive:true,force:true});});return {get m(){return m},restart(){m.close();m=createPatrolTaskMemory({databasePath:path,now:()=>++now});},begin:(cmid,input,extra={})=>m.begin({peer,user:7,cmid,input,...extra})};}
test('reply restores actual task, evidence and delivered output after restart',t=>{
 const f=fixture(t),a=f.begin(10,'Найди что говорили о концерте');f.m.observe(a.turnId,{action:'search_history',result:{messages:[{cmid:4,text:'в пятницу'}]}});
 f.m.output(a.turnId,'Концерт в пятницу',{conversation_message_id:11,message_id:111});f.m.summary(a.turnId,{summary:'нашли концерт',sourceCmids:[4,999],pending:[]});f.m.finish(a.turnId,'answered');f.restart();
 const b=f.begin(12,'Нет, уточни время',{reply:{conversation_message_id:11}});assert.equal(b.taskId,a.taskId);
 const context=f.m.context(b.turnId);assert.equal(context.turns[0].outputs[0].text,'Концерт в пятницу');assert.deepEqual(context.turns[0].summary.sourceCmids,[4]);assert.equal(context.turns[0].userMessage.cmid,10);
});
test('user/chat isolation and duplicate delivery',t=>{
 const f=fixture(t),a=f.begin(10,'Первая задача');assert.equal(f.begin(10,'Повтор').duplicate,true);
 const other=f.begin(12,'Чужая реплика',{user:8,reply:{conversation_message_id:10}});assert.notEqual(a.taskId,other.taskId);assert.throws(()=>f.m.resume(other.turnId,a.taskId),/another user/);
 assert.throws(()=>f.begin(13,'чужая беседа',{peer:2000000006}),/scope/);
});
test('same user has separate tasks and can explicitly resume chosen work before tools',t=>{
 const f=fixture(t),a=f.begin(10,'Картинка'),b=f.begin(12,'Тусы');assert.notEqual(a.taskId,b.taskId);
 const c=f.begin(14,'Сделай темнее');assert.equal(c.linked,false);assert.equal(c.candidates.length,2);f.m.resume(c.turnId,a.taskId);assert.equal(f.m.context(c.turnId).taskId,a.taskId);
 f.m.observe(c.turnId,{action:'create_image',result:[]});assert.throws(()=>f.m.resume(c.turnId,b.taskId),/before executing/);
});
test('attachment match resolves missing VK delivery CMID without confusing global ID',t=>{
 const f=fixture(t),a=f.begin(10,'Изображение');f.m.output(a.turnId,{message:'Готово',attachment:'photo-1_25'},100);
 const b=f.begin(12,'Измени',{reply:{conversation_message_id:55,attachments:[{type:'photo',photo:{owner_id:-1,id:25}}]}});assert.equal(b.taskId,a.taskId);assert.equal(f.m.context(b.turnId).turns[0].outputs[0].cmid,55);
});
test('ambiguous repeated output text does not select an unrelated task',t=>{
 const f=fixture(t);for(const n of [10,20]){const a=f.begin(n,'задача '+n);f.m.output(a.turnId,'Готово',0);}
 assert.equal(f.begin(30,'переделай',{reply:{text:'Готово'}}).linked,false);
});
test('image version is persisted and another task cannot load it',async t=>{
 const f=fixture(t),a=f.begin(10,'Изображение'),image=await f.m.saveArtifact(a.turnId,{buffer:Buffer.from('actual test image bytes'),mimeType:'image/png',attachment:'photo1_2'});
 f.m.output(a.turnId,{attachment:'photo1_2'},0);f.restart();assert.ok((await f.m.artifact(a.turnId,image)).dataUrl.endsWith(Buffer.from('actual test image bytes').toString('base64')));
 const b=f.begin(12,'Другая задача');await assert.rejects(()=>f.m.artifact(b.turnId,image),/No saved image/);
});

test('foreign peer CMID collisions never select memory',t=>{
 const f=fixture(t),a=f.begin(10,'Своя задача');f.m.output(a.turnId,'Результат',{conversation_message_id:11});
 assert.equal(f.begin(12,'поправь',{reply:{peer_id:2000000044,conversation_message_id:11}}).linked,false);
});
test('reply to an older image keeps that version instead of the last generated image',async t=>{
 const f=fixture(t),a=f.begin(10,'Картинка');const first=await f.m.saveArtifact(a.turnId,{buffer:Buffer.from('first'),attachment:'photo1_1'});
 f.m.output(a.turnId,{attachment:'photo1_1'},{conversation_message_id:11});
 const b=f.begin(12,'новая версия',{reply:{conversation_message_id:11}});await f.m.saveArtifact(b.turnId,{buffer:Buffer.from('second'),attachment:'photo1_2'});f.m.output(b.turnId,{attachment:'photo1_2'},{conversation_message_id:13});
 const c=f.begin(14,'вернись к первой',{reply:{conversation_message_id:11}});assert.equal(c.replyArtifactId,first);assert.ok((await f.m.artifact(c.turnId,c.replyArtifactId)).dataUrl.endsWith(Buffer.from('first').toString('base64')));
});
test('a read before resume is allowed and records stay accessible only inside the selected task',t=>{
 const f=fixture(t),a=f.begin(10,'Старая задача'),b=f.begin(12,'Продолжим');f.m.observe(b.turnId,{action:'search_history',result:{messages:[{cmid:3,text:'источник'}]}});
 f.m.resume(b.turnId,a.taskId);assert.equal(f.m.context(b.turnId).taskId,a.taskId);assert.equal(f.m.history(b.turnId,b.turnId).records[0].body.sourceCmids[0],3);
 const c=f.begin(15,'другое');assert.throws(()=>f.m.history(c.turnId,b.turnId),/scope/);
});
