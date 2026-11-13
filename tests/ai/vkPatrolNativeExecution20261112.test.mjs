import test from 'node:test';
import assert from 'node:assert/strict';
import {executePatrolNativeCapability,patrolToolCallKey,patrolPlannerObservations} from '../../src/features/ai/vkPatrolNativeExecution.js';
const selected={ok:true,capabilityId:'english.enable',command:'English вкл',expectedResult:'on',readOnly:false};
const context={platform:'vk',peerId:2000000011,isPrivate:false,isOwner:false};
test('three dependent native steps wait for real queue completion',async()=>{
 let enabled=0;const calls=[];
 const service={handle(c,observe){const completion=new Promise(resolve=>setImmediate(()=>{calls.push(c.text);if(c.text==='English вкл')enabled=1;resolve();}));observe(completion);return true;},inspect(){return {subscription:{enabled}};}};
 const run=s=>executePatrolNativeCapability({selected:s,context,services:{english:service}});
 const before=await run({...selected,readOnly:true,expectedResult:'status',command:'English статус'});
 assert.equal(before.state.subscription.enabled,0);
 const on=await run(selected);assert.equal(on.verified,true);
 const after=await run({...selected,readOnly:true,expectedResult:'status',command:'English статус'});
 assert.equal(after.state.subscription.enabled,1);assert.deepEqual(calls,['English статус','English вкл','English статус']);
});
test('native acceptance, failure and unmet goal are not successful completion',async()=>{
 const run=service=>executePatrolNativeCapability({selected,context,services:{english:service}});
 assert.equal((await run({handle:()=>true,inspect:()=>({})})).status,'accepted-unverified');
 const failed=await run({handle(c,cb){cb(Promise.reject(Error('send failed')));return true;},inspect:()=>({})});
 assert.equal(failed.status,'failed');assert.equal(failed.retrySafe,false);
 const blocked=await run({handle(c,cb){cb(Promise.resolve());return true;},inspect:()=>({subscription:{enabled:0}})});
 assert.equal(blocked.status,'goal-not-reached');assert.equal(blocked.verified,false);
});
test('dedupe includes photo index, query boundaries and ordering but ignores reasoning',()=>{
 const a={action:'inspect_image',cmid:25,photoIndex:0};
 assert.notEqual(patrolToolCallKey(a),patrolToolCallKey({...a,photoIndex:1}));
 assert.equal(patrolToolCallKey(a),patrolToolCallKey({reason:'reworded',photoIndex:0,cmid:25,action:'inspect_image'}));
 for(const field of ['afterDate','beforeDate','orderBy','direction','term','includeContext'])assert.notEqual(patrolToolCallKey({action:'search_photos'}),patrolToolCallKey({action:'search_photos',[field]:'different'}));
});
test('bounded evidence stays valid JSON and explicitly marks truncation',()=>{
 const text=patrolPlannerObservations([{action:'history',result:'x'.repeat(80000)},{action:'native_capability',result:{verified:true}}],4000);
 const parsed=JSON.parse(text);assert.ok(text.length<4100);assert.ok(parsed.observations[0].truncated);assert.equal(parsed.observations.at(-1).result.verified,true);
});

import {parsePatrolAgentPlan} from '../../src/features/ai/vkPatrolAgentProtocol.js';
test('malformed photo references, confidence and filters fail before execution',()=>{
 for(const plan of [{action:'inspect_image',cmid:1,photoIndex:-1},{action:'native_capability',capabilityId:'english.enable',confidence:true},{action:'db_query',table:'vk_events',filters:[{column:'title',value:{nested:'bad'}}]},{action:'create_image_from_photos',photos:[{cmid:1,photoIndex:99}]}])assert.equal(parsePatrolAgentPlan(JSON.stringify(plan)).ok,false);
});
