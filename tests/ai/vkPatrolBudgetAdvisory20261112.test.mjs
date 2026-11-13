import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readJsonlTail} from '../../src/features/ai/vkPatrolLogTail.js';
import {patrolProgressHint} from '../../src/features/ai/vkPatrolNativeExecution.js';
const dir=mkdtempSync(join(tmpdir(),'patrol-advisory-'));
process.env.GIGORAVE_DATA_DIR=dir;
const m=await import('../../src/features/ai/vkPatrolAdaptive.js?advisory');
test.after(()=>rmSync(dir,{recursive:true,force:true}));
test('300k adds advice, allows continued work; 3m stops new calls',async()=>{
 const r=await m.runPatrolScopedRequest('budget-test',async()=>{
  const use=n=>m.recordPatrolTokenUsage({totalTokens:n,usageSource:'provider'});
  use(299999);assert.equal(m.patrolBudgetGuidance(),'');
  use(1);assert.match(m.patrolBudgetGuidance(),/пожелание/);assert.equal(m.patrolCanCallModel(100000),true);
  use(2699999);assert.equal(m.patrolRequestTokenRemaining(),1);
  use(1);assert.equal(m.patrolRequestTokenRemaining(),0);assert.equal(m.patrolCanCallModel(),false);
 });assert.equal(r.allowed,true);
 await m.runPatrolScopedRequest('fresh',async()=>assert.equal(m.patrolBudgetGuidance(),''));
});
test('planner has no output cap and receives soft advice without mixing learned chat style',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const start=app.indexOf('async function handlePatrolAdaptive('),end=app.indexOf("tokenUsageOperation:'vk-patrol-adaptive-planner'",start);
 const call=app.slice(app.lastIndexOf('generateOpenAIText({',end),end);
 assert.ok(!/maxTokens\s*:/.test(call));assert.ok(app.includes('patrolBudgetGuidance(),patrolProgressHint(note)'));
 assert.ok(!app.slice(start,app.indexOf('const seen=new Set()',start)).includes('chatLearningInstruction'));
});
test('tail keeps Unicode across blocks, malformed lines and the last line without newline',()=>{
 const path=join(dir,'tail.jsonl');const rows=Array.from({length:600},(_,id)=>({id,text:'Привет! ё'.repeat(70)}));
 writeFileSync(path,rows.map(JSON.stringify).join('\n')+'\nnot-json');
 assert.deepEqual(readJsonlTail(path,100),rows.slice(-100));assert.deepEqual(readJsonlTail(path,0),[]);
 writeFileSync(path,JSON.stringify(rows[0]));assert.deepEqual(readJsonlTail(path,5),[rows[0]]);
});
test('no-progress advice does not trigger on different successful pages',()=>{
 assert.equal(patrolProgressHint([{action:'search',result:{matches:1}},{action:'search',result:{matches:2}},{action:'search',result:{matches:3}}]),'');
 assert.match(patrolProgressHint(Array.from({length:3},()=>({action:'search',result:{matches:0}}))),/подсказка/);
});
