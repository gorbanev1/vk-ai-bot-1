import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');

test('the real Patrol planner imports its runtime token-budget constants',()=>{
 const start=app.indexOf('import {PATROL_PEER_ID,');
 const end=app.indexOf("from '../features/ai/vkPatrolAdaptive.js';",start);
 assert.ok(start>=0&&end>start);
 const imp=app.slice(start,end);
 for(const name of ['PATROL_PEER_ID','PATROL_REQUEST_TOKEN_LIMIT',
   'PATROL_DAILY_TOKEN_LIMIT','PATROL_MAX_STEPS'])
  assert.ok(new RegExp('\\b'+name+'\\b').test(imp),name+' missing import');
});
test('Patrol incoming requests persist before any adaptive return, without double-write',()=>{
 const handler=app.indexOf('async function handleVkIncomingMessageCore(');
 const preArchive=app.indexOf('await scheduleVkLivePersistence(context,{',handler);
 const planner=app.indexOf('const scoped=await runPatrolScopedRequest(',handler);
 assert.ok(handler>0&&preArchive>handler&&preArchive<planner,
  'Original chat message must persist before Luna gets the context');
 assert.match(app,/if\s*\(\s*!privateMode\s*&&\s*!patrolActiveScope\(\)\?\.preArchived\s*\)/u);
 assert.match(app,/active\.preArchived=patrolAddressedMessage\(/u);
});
test('startup backfills missing original VK messages, not guessed text from traces',()=>{
 assert.match(app,/async function recoverPatrolRecentMessageArchive\(\)/u);
 assert.match(app,/getByConversationMessageId\(\{/u);
 assert.match(app,/conversation_message_ids:cmids,extended:1/u);
 assert.match(app,/await archiveVkMessageFromMessageLive\(item,\{/u);
 assert.match(app,/durableJournal:true/u);
 assert.match(app,/\[PATROL ARCHIVE CONTINUITY REPAIRED\]/u);
});
test('the agent has a structured Sol/Astra writing stage and Luna High evaluator',()=>{
 assert.match(app,/if\(action==='build_module'\)/u);
 assert.match(app,/buildPatrolModuleViaWorkers\(\{/u);
 assert.match(app,/evaluateCandidate:async proposal=>/u);
 assert.match(app,/tokenUsageOperation:'vk-patrol-adaptive-module-coder'/u);
 assert.match(app,/tokenUsageOperation:'vk-patrol-adaptive-module-evaluator'/u);
 assert.match(app,/status:'sandbox-executed-needs-luna-evaluation'/u);
 assert.match(app,/write_module is reserved for exact source provided by a human/u);
 assert.match(app,/const moduleRegistry=createPatrolModuleRegistry\(\)/u);
 assert.match(app,/JSON\.stringify\(registeredModules\.map/u);
});
test('adaptive code writes never modify the original main bot source',()=>{
 const start=app.indexOf("        if(action==='build_module'){");
 const end=app.indexOf("        if(action==='run_module'){",start);
 const branch=app.slice(start,end);
 assert.match(branch,/listModules:listPatrolModules,writeModule:writePatrolModule/u);
 assert.match(branch,/runModule:runPatrolModule/u);
 assert.doesNotMatch(branch,/writeFileSync\(/u);
 assert.doesNotMatch(branch,/renameSync\(/u);
});
