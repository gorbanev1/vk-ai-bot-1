import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createChatModelExperiment,parseChatModelExperiment} from '../../src/features/ai/chatModelExperiment.js';
import {sampleChatLearning} from '../../src/features/personality/chatLearningWorker.js';
import {learningPassed,validateStyleProfile} from '../../src/features/personality/chatLearning.js';
const context={platform:'vk',peerId:2000000006};
test('frequency commands accept both bot forms, refuse zero, and allow off',()=>{
 assert.equal(parseChatModelExperiment('ответы бота сол астра 4').frequency,4);
 assert.equal(parseChatModelExperiment('ответы бот сол астра 15').frequency,15);
 assert.equal(parseChatModelExperiment('ответы бот сол астра выкл').frequency,0);
 assert.equal(parseChatModelExperiment('ответы бот сол астра 0').valid,false);
 assert.equal(parseChatModelExperiment('досье сол'),null);
});
test('every fourth delivered response selects a model; failures do not count; state survives restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'gigo-experiment-'));
 try{
  let app=createChatModelExperiment({directory,random:()=>0});await app.configure(context,4);
  const observed=[];
  for(let i=0;i<3;i++)await app.run(context,async(plan,done)=>{observed.push(plan);await done({actualModel:'gpt-6-luna'});});
  await assert.rejects(app.run(context,async(plan)=>{assert.equal(plan.model,'gpt-6.1-sol');throw Error('provider');}));
  assert.equal((await app.inspect(context)).count,3);
  app=createChatModelExperiment({directory,random:()=>1});
  await app.run(context,async(plan,done)=>{assert.deepEqual(plan,{model:'gpt-6-astra',reasoningEffort:'high'});await done({actualModel:plan.model});await done();});
  assert.equal((await app.inspect(context)).count,4);
  assert.ok(observed.every(x=>x===null));
  const lines=(await readFile(join(directory,'outcomes.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length,4);assert.equal(lines[3].actualModel,'gpt-6-astra');
  await app.configure(context,0);
  await app.run(context,async(plan,done)=>{assert.equal(plan,null);await done();});
  assert.equal((await app.inspect(context)).frequency,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('parallel responses are serialized only within their chat and counted once',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'gigo-experiment-'));
 try{
  const app=createChatModelExperiment({directory,random:()=>0});await app.configure(context,2);
  let release;const gate=new Promise(r=>release=r);let entered;const ready=new Promise(r=>entered=r);
  const first=app.run(context,async(p,done)=>{entered();await gate;await done();});await ready;
  let secondStarted=false;const second=app.run(context,async(p,done)=>{secondStarted=true;assert.ok(p);await done();});
  await app.run({...context,peerId:123},async(p)=>assert.equal(p,null));
  assert.equal(secondStarted,false);release();await Promise.all([first,second]);
  assert.equal((await app.inspect(context)).count,2);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('learning sample uses disjoint train and held-out episodes with original reaction metadata',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE vk_message_archive(peer_id,sender_id,conversation_message_id,text,raw_message_json,created_at)');
  const put=db.prepare('INSERT INTO vk_message_archive VALUES(1,?,?,?,?,?)');
  for(let i=0;i<120;i++){put.run(10,i*2,'Вопрос '+i,'{}',i);put.run(-20,i*2+1,'Ответ '+i,'{"reactions":[{"reaction_id":1,"count":2}]}',i);}
  const s=sampleChatLearning(db,{peerId:1,botId:-20});
  assert.equal(s.train.length,64);assert.equal(s.holdout.length,16);
  const ids=new Set(s.train.map(x=>x.id));assert.ok(s.holdout.every(x=>!ids.has(x.id)));
  assert.equal(s.train[0].answer.reactions[0].count,2);
 }finally{db.close();}
});
test('validation gate rejects missing, duplicate, ungrounded and wrong-target evaluations',()=>{
 const good=Array.from({length:16},(_,id)=>({id,winner:'new',newGrounded:true,targetCorrect:true}));
 assert.equal(learningPassed(good,16),true);
 assert.equal(learningPassed(good.slice(1),16),false);
 assert.equal(learningPassed(good.map(x=>({...x,id:1})),16),false);
 assert.equal(learningPassed(good.map((x,i)=>i?x:{...x,targetCorrect:false}),16),false);
 assert.equal(learningPassed(good.map(x=>({...x,winner:'old'})),16),false);
 assert.throws(()=>validateStyleProfile({rules:[],examples:[]}));
});
