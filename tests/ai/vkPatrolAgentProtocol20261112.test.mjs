import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parsePatrolAgentPlan,patrolAgentToolCatalog}
 from '../../src/features/ai/vkPatrolAgentProtocol.js';
import {runPatrolRecurringTool} from '../../src/features/ai/vkPatrolRecurringTool.js';
import {parsePatrolAdaptiveToggleCommand,PATROL_DAILY_TOKEN_LIMIT,PATROL_REQUEST_TOKEN_LIMIT}
 from '../../src/features/ai/vkPatrolAdaptive.js';
import {createRecurringChatWriteService} from '../../src/features/routing/recurringChatWrite.js';
import {PATROL_ALLOWED_ACTIONS} from '../../src/features/ai/vkPatrolCapabilityPolicy.js';

test('typed tool catalog uses actions authorized by the current host',()=>{
 const x=patrolAgentToolCatalog([{id:'english.status'}]);
 for(const tool of x.tools)assert.ok(PATROL_ALLOWED_ACTIONS.includes(tool.name),tool.name);
 for(const name of ['db_catalog','db_query','inspect_image','recurring_chat','write_module',
   'run_module','discover_capabilities','native_capability','answer','clarify'])
  assert.ok(x.tools.find(t=>t.name===name));
 assert.equal(x.nativeCapabilities[0].id,'english.status');
 assert.equal(PATROL_DAILY_TOKEN_LIMIT,10_000_000);
 assert.equal(PATROL_REQUEST_TOKEN_LIMIT,3_000_000);
});
test('Luna tool protocol parses complete fenced or prefixed JSON and rejects ill-typed calls',()=>{
 assert.equal(parsePatrolAgentPlan('{"action":"answer","answer":"OK"}').ok,true);
 const fence=String.fromCharCode(96).repeat(3);
 assert.equal(parsePatrolAgentPlan(fence+'json\n{"action":"recurring_chat","reason":"requested"}\n'+fence).plan.action,'recurring_chat');
 assert.equal(parsePatrolAgentPlan('Some text {"action":"db_query","table":"vk_message_archive","filters":[{"column":"text","op":"contains","value":"a } b"}]} trailing').ok,true);
 for(const s of ['bad answer','{"action":"invented"}','{"action":"answer","answer":10}',
  '{"action":"write_module","name":"x"}','{"action":"message_context","cmid":-3}',
  '{"action":"native_capability","confidence":0.9}'])
  assert.equal(parsePatrolAgentPlan(s).ok,false,s);
});
test('planner may ask for clarification and confidence is bounded',()=>{
 assert.equal(parsePatrolAgentPlan('{"action":"clarify","answer":"Что именно сделать?","confidence":0.2}').ok,true);
 assert.equal(parsePatrolAgentPlan('{"action":"answer","answer":"ok","confidence":0.59}').ok,true);
 assert.equal(parsePatrolAgentPlan('{"action":"answer","answer":"ok","confidence":1.1}').ok,false);
});
test('recurring agent tool uses only real user command, verifies SQLite and prevents invented schedules',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patrol-recurring-'));
 let now=100000000;
 const send=[];
 const service=createRecurringChatWriteService({databasePath:join(root,'jobs.sqlite'),
  now:()=>now,send:async x=>send.push(x),log:{warn(){}}});
 const scope={platform:'vk',peerId:'2000000011',senderId:'777',endpointKey:'vk:primary'};
 const other={...scope,peerId:'2000000006'};
 try{
  const requested='\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432 \u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u0443\u044e \u0441\u0435\u043a\u0443\u043d\u0434\u0443';
  const create=runPatrolRecurringTool({ownerAuthorized:true,originalQuestion:requested,service,scope});
  assert.equal(create.ok,true);
  assert.equal(create.job.intervalMs,1000);
  assert.equal(create.verified,true);
  assert.equal(runPatrolRecurringTool({ownerAuthorized:true,originalQuestion:requested,service,scope}).existing,true);
  assert.equal(service.list(other).length,0);
  assert.equal(runPatrolRecurringTool({ownerAuthorized:true,originalQuestion:'\u043f\u0440\u0438\u0432\u0435\u0442',
    candidates:[],scope,service}).ok,false,'model cannot invent scheduling');
  now+=1000;
  assert.equal((await service.tick()).sent,1);
  assert.equal(send[0].text,'\u043f\u0440\u0438\u0432\u0435\u0442');
  assert.equal(runPatrolRecurringTool({ownerAuthorized:true,originalQuestion:'\u043f\u0438\u0448\u0438 \u0432\u0441\u0435 \u0430\u043a\u0442\u0438\u0432\u043d\u044b\u0435',scope,service}).jobs.length,1);
  assert.equal(runPatrolRecurringTool({ownerAuthorized:true,originalQuestion:'\u043d\u0435 \u043f\u0438\u0448\u0438 1',scope,service}).remaining,0);
  now+=1000;assert.equal((await service.tick()).sent,0);
 }finally{service.close();rmSync(root,{recursive:true,force:true})}
});
test('agent mode is an alias of the one existing adaptive mode, never a new chat setting',()=>{
 const a='\u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0432\u043a\u043b';
 const b='\u0430\u0433\u0435\u043d\u0442\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0432\u043a\u043b';
 assert.deepEqual(parsePatrolAdaptiveToggleCommand(b),parsePatrolAdaptiveToggleCommand(a));
});
test('runtime protocol enforces observed tools, bounded invalid-plan retries and sandbox last resort',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 for(const r of [/parsePatrolAgentPlan\(rawText\)/u,/invalidToolPlans<3/u,
  /runPatrolRecurringTool\(/u,/patrolAgentToolCatalog\(existingNativeCapabilities\)/u,
  /if\(action==='write_module'\)/u,/if\(action==='run_module'\)/u,
  /patrolTraceStatus\('planner-failed'/u, /clarification-required/u,
  /confidence.*0\.60/u])
  assert.match(app,r);
});
