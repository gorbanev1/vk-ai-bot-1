import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHuinglishCommand} from '../../src/features/english/huinglishVkLesson.js';
import {
 PATROL_PEER_ID,patrolShouldRepairNativeNoOutput,
 markPatrolNativeCommandHandled,patrolActiveScope,runPatrolScopedRequest
} from '../../src/features/ai/vkPatrolAdaptive.js';

test('HuInglish off is parsed as a native command and does not require a second adaptive answer',async()=>{
 assert.deepEqual(parseHuinglishCommand('\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432 \u0425\u0443\u0438\u043d\u0433\u043b\u0438\u0448 \u0432\u044b\u043a\u043b'),{type:'off'});
 const processed=await runPatrolScopedRequest('queued-native-regression',async()=>{
  const scope=patrolActiveScope();
  scope.addressed=true;
  scope.delegatedNative=true;
  scope.sentCount=0;
  assert.equal(patrolShouldRepairNativeNoOutput(scope),true);
  assert.equal(markPatrolNativeCommandHandled('huinglish'),true);
  assert.equal(patrolShouldRepairNativeNoOutput(scope),false);
  return true;
 });
 assert.equal(processed.allowed,true);
 assert.equal(processed.result,true);
});

test('an unhandled native request can still be repaired, but queued or sent requests cannot',()=>{
 const scope={peerId:PATROL_PEER_ID,adaptive:true,addressed:true,delegatedNative:true,sentCount:0};
 assert.equal(patrolShouldRepairNativeNoOutput(scope),true);
 scope.nativeCommandHandled=true;
 assert.equal(patrolShouldRepairNativeNoOutput(scope),false);
 scope.nativeCommandHandled=false;
 scope.sentCount=1;
 assert.equal(patrolShouldRepairNativeNoOutput(scope),false);
 scope.sentCount=0;
 scope.adaptive=false;
 assert.equal(patrolShouldRepairNativeNoOutput(scope),false);
 scope.adaptive=true;
 scope.peerId=2000000006;
 assert.equal(patrolShouldRepairNativeNoOutput(scope),false);
 assert.equal(markPatrolNativeCommandHandled('outside-scope'),false);
});

test('VK routed async commands mark handled before returning',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/if \(huinglishLessons\.handle\([\s\S]*?markPatrolNativeCommandHandled\('huinglish'\);/u);
 assert.match(app,/if \(englishGrammar\.handle\([\s\S]*?markPatrolNativeCommandHandled\('english-grammar'\);/u);
 assert.match(app,/if \(await handleChtivoCommand\([\s\S]*?markPatrolNativeCommandHandled\('chtivo'\);/u);
 assert.match(app,/if\(patrolShouldRepairNativeNoOutput\(scope\)\)/u);
});
