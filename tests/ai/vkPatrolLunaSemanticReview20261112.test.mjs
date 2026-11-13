import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPatrolModuleRegistry,buildPatrolModuleViaWorkers}
 from '../../src/features/ai/vkPatrolAgentModulePipeline.js';
test('Luna semantic rejection of a correctly executing module triggers Sol high next',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patrol-luna-judge-'));
 const reg=createPatrolModuleRegistry({filename:join(root,'registry.json')});
 const stages=[],judgments=[],files=new Map();
 try{
  const done=await buildPatrolModuleViaWorkers({
   name:'summary',task:'Summarize latest messages',request:'Summarize all recent messages',
   input:{count:3},registry:reg,listModules:()=>[...files.keys()].map(name=>({name})),
   writeModule:({name,source})=>files.set(name,source),
   runModule:async()=>({ok:true,total:3}),
   callCoder:async(worker)=>{stages.push(worker.model+':'+worker.reasoningEffort);
    return 'export async function run(api){return {ok:true,total:api.input.count}}'},
   evaluateCandidate:async({stage,output})=>{
    judgments.push(stage);
    assert.equal(output.total,3);
    return {verdict:stage===1?'partial':'satisfied',
     reason:stage===1?'It does not summarize the content':'Sufficient summary for the user'};
   },
  });
  assert.equal(done.status,'sandbox-executed');
  assert.equal(done.attempts,2);
  assert.deepEqual(judgments,[1,2]);
  assert.deepEqual(stages,['gpt-6.1-sol:medium','gpt-6.1-sol:high']);
  assert.equal(done.lunaVerdict.verdict,'satisfied');
  assert.equal(reg.list().length,1);
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('a Luna semantic failure at all four stages does not register unsuccessful code',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patrol-luna-reject-'));
 const reg=createPatrolModuleRegistry({filename:join(root,'registry.json')});
 let calls=0;
 try{
  const result=await buildPatrolModuleViaWorkers({
   name:'x',task:'Actual task',request:'User wants a real result',
   input:{},registry:reg,listModules:()=>[],
   writeModule:()=>({name:'x'}),runModule:async()=>({ok:true}),
   callCoder:async()=>{calls++;return 'export async function run(api){return true}'},
   evaluateCandidate:async()=>({verdict:'failed',reason:'Result does not meet the original user request'}),
  });
  assert.equal(calls,4);
  assert.equal(result.status,'all-code-workers-failed');
  assert.equal(result.attempts.length,4);
  assert.equal(reg.list().length,0);
 }finally{rmSync(root,{recursive:true,force:true})}
});
