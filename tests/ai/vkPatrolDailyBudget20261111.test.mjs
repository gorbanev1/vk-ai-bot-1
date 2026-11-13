import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const temp=mkdtempSync(join(tmpdir(),'patrol-daily10m-'));
const previous=process.env.GIGORAVE_DATA_DIR;
process.env.GIGORAVE_DATA_DIR=temp;
const patrol=await import('../../src/features/ai/vkPatrolAdaptive.js?dailyTenMillion20261111');
test('10-million daily cap uses existing provider usage ledger and remains strict',async()=>{
 assert.equal(patrol.PATROL_DAILY_TOKEN_LIMIT,10_000_000);
 assert.equal(patrol.PATROL_REQUEST_TOKEN_LIMIT,3_000_000);
 const info=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
  timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'})
  .formatToParts(new Date()).map(x=>[x.type,x.value]));
 const day=[info.year,info.month,info.day].join('-');
 const folder=join(temp,'vk-patrol-adaptive');
 mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'usage-'+day+'.jsonl'),
  JSON.stringify({tokens:9_500_000,inputTokens:9_440_000,
   outputTokens:60_000,usageSource:'provider'})+'\n');
 assert.equal(patrol.patrolUsage().tokens,9_500_000);
 assert.equal(patrol.patrolCanSpend(),true);
 const allowed=await patrol.runPatrolScopedRequest('finish-within-daily-limit',async()=>{
  assert.equal(patrol.patrolCanSpend(),true);
  patrol.recordPatrolTokenUsage({timestamp:new Date().toISOString(),
   totalTokens:500_000,inputTokens:499_000,outputTokens:1_000,
   capability:'text',usageSource:'provider',operation:'vk-patrol-adaptive-planner'});
  return 'done';
 });
 assert.equal(allowed.allowed,true);
 assert.equal(allowed.result,'done');
 assert.equal(patrol.patrolUsage().tokens,10_000_000);
 assert.equal(patrol.patrolCanSpend(),false);
 const blocked=await patrol.runPatrolScopedRequest('denied-request',
  ()=>{throw Error('denied handler should not run')});
 assert.equal(blocked.allowed,false);
 assert.equal(blocked.reason,'daily-token-budget');
 assert.match(readFileSync(join(folder,'budget-denials-'+day+'.jsonl'),'utf8'),
  /denied-request/);
});
test('no unmetered freeform model fallback, while existing commands can remain available',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/if\(!explicitCommand&&patrolAddressedMessage\(submitted,/u);
 assert.match(app,/if\(scoped\.allowed\)return scoped\.result/u);
 assert.match(app,/patrolTraceStatus\('planner-failed'/u);
 assert.match(app,/per-day adaptive token limit '\+PATROL_DAILY_TOKEN_LIMIT/u);
});
test.after(()=>{
 if(previous===undefined)delete process.env.GIGORAVE_DATA_DIR;
 else process.env.GIGORAVE_DATA_DIR=previous;
 rmSync(temp,{recursive:true,force:true});
});
