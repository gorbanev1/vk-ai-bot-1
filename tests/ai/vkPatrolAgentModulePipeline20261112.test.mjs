import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
 PATROL_CODE_WORKER_SEQUENCE,createPatrolModuleRegistry,
 buildPatrolModuleViaWorkers,parsePatrolCoderSource,
} from '../../src/features/ai/vkPatrolAgentModulePipeline.js';

test('the Luna-planned fallback is Sol medium, Sol high, Astra medium, Astra high',()=>{
 assert.deepEqual(PATROL_CODE_WORKER_SEQUENCE.map(x=>[x.model,x.reasoningEffort]),[
  ['gpt-6.1-sol','medium'],['gpt-6.1-sol','high'],
  ['gpt-6-astra','medium'],['gpt-6-astra','high'],
 ]);
});
test('coder output must export a bounded ESM run(api); JSON and fenced code work',()=>{
 const code='export async function run(api){return {ok:true,count:api.input.count}}';
 assert.equal(parsePatrolCoderSource(JSON.stringify({source:code})),code);
 assert.equal(parsePatrolCoderSource('\x60\x60\x60javascript\n'+code+'\n\x60\x60\x60'),code);
 assert.throws(()=>parsePatrolCoderSource('require("fs").unlinkSync("bot.js")'),/export/);
 assert.throws(()=>parsePatrolCoderSource('hello'),/export/);
});
test('4-stage worker code cycle persists only verified modules and returns tested output to Luna',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patrol-workers-'));
 const registry=createPatrolModuleRegistry({filename:join(root,'verified.json')});
 const sourceByName=new Map(),stages=[],traces=[];
 const request='\u0421\u0434\u0435\u043b\u0430\u0439 \u043d\u043e\u0432\u0443\u044e \u0441\u0432\u043e\u0434\u043a\u0443';
 const goal='Calculate a safely scoped summary of archived chat text';
 const args={name:'chat_summary',task:goal,request,input:{limit:5},
  registry,listModules:()=>[...sourceByName.keys()].map(name=>({name})),
  writeModule:({name,source})=>{sourceByName.set(name,source);return {name}},
  runModule:async name=>{
   const s=sourceByName.get(name);
   if(!s.includes('SUCCESS'))throw Error('QuickJS smoke test failed');
   return {ok:true,total:5};
  },
  callCoder:async(worker,task)=>{
   stages.push(worker.model+':'+worker.reasoningEffort);
   assert.equal(task.request,request);
   assert.equal(task.task,goal);
   assert.ok(task.previousErrors.length===stages.length-1);
   return {text:JSON.stringify({source:'export async function run(api){return {ok:true,label:"'+
    (stages.length===4?'SUCCESS':'BAD')+'",total:api.input.limit}}'})};
  },
  trace:x=>traces.push(x),
 };
 try{
  const built=await buildPatrolModuleViaWorkers(args);
  assert.equal(built.status,'sandbox-executed');
  assert.equal(built.requiresLunaEvaluation,true);
  assert.equal(built.attempts,4);
  assert.deepEqual(stages,[
   'gpt-6.1-sol:medium','gpt-6.1-sol:high',
   'gpt-6-astra:medium','gpt-6-astra:high',
  ]);
  assert.equal(registry.list().length,1);
  assert.equal(registry.list()[0].name,'chat_summary');
  assert.match(readFileSync(join(root,'verified.json'),'utf8'),/chat_summary/);
  assert.ok(traces.some(x=>x.status==='sandbox-executed'));
  const reused=await buildPatrolModuleViaWorkers({...args,
   callCoder:()=>{throw Error('Should reuse without calling a model')},
   runModule:async()=>({ok:true,total:5}),
  });
  assert.equal(reused.reused,true);
  assert.equal(reused.output.total,5);
  assert.equal(registry.list().length,1);
  const version=await buildPatrolModuleViaWorkers({...args,task:'Another user goal',
   callCoder:async()=>({text:'export async function run(api){return {ok:true,label:"SUCCESS"}}'}),
   runModule:async()=>({ok:true}),stopAfter:1});
  assert.equal(version.name,'chat_summary_v2','must not overwrite previously verified code');
  assert.equal(registry.list().length,2);
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('worker budget stops the stage ladder without inventing success or deleting anything',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patrol-code-budget-'));
 const registry=createPatrolModuleRegistry({filename:join(root,'registry.json')});
 let calls=0;
 try{
  const result=await buildPatrolModuleViaWorkers({
   name:'safe',task:'Count words',request:'Please count words',input:{},
   registry,listModules:()=>[],writeModule:()=>{throw Error('must not run')},
   runModule:()=>{throw Error('must not run')},
   canCallModel:()=>false,callCoder:()=>{calls++;throw Error('must not call')},
  });
  assert.equal(calls,0);
  assert.equal(result.status,'token-budget-exhausted');
  assert.equal(registry.list().length,0);
  assert.equal(existsSync(join(root,'registry.json')),false);
 }finally{rmSync(root,{recursive:true,force:true})}
});
