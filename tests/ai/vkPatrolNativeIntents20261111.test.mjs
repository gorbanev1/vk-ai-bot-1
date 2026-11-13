import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const tmp=mkdtempSync(join(tmpdir(),'patrol-native-intent-'));
const previous=process.env.GIGORAVE_DATA_DIR;
process.env.GIGORAVE_DATA_DIR=tmp;
const capabilities=await import('../../src/features/ai/vkPatrolNativeCapabilities.js');
const routing=await import('../../src/features/ai/vkPatrolNativeRouting.js');
const scoped=await import('../../src/features/ai/vkPatrolAdaptive.js');
const {parseHuinglishCommand}=await import('../../src/features/english/huinglishVkLesson.js');
const {parseEnglishGrammarCommand}=await import('../../src/features/english/englishGrammarCourse.js');
const choose=capabilities.resolvePatrolNativeCapability;
test('read-only native requests work with 0.55 confidence using real existing parsers',()=>{
 const checks=[
  ['huinglish.status','\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u0447\u0442\u043e \u0441 \u0445\u0443\u0438\u043d\u0433\u043b\u0438\u0448\u0435\u043c?','status',parseHuinglishCommand],
  ['english.status','\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u043a\u0430\u043a\u043e\u0439 \u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441 \u043f\u043e English?','status',parseEnglishGrammarCommand],
  ['english.lessons','\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u043a\u0430\u043a\u0438\u0435 English \u0443\u0440\u043e\u043a\u0438 \u0435\u0441\u0442\u044c?','list',parseEnglishGrammarCommand],
 ];
 for(const [id,request,type,parser] of checks){
  const x=choose({capabilityId:id,confidence:0.55,request});
  assert.equal(x.ok,true,JSON.stringify(x));
  assert.equal(parser(x.command)?.type,type);
 }
});
test('mutating HuInglish cannot execute without explicit request and high confidence',()=>{
 for(const request of [
  '\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u043a\u0430\u043a \u0432\u044b\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u0445\u0443\u0438\u043d\u0433\u043b\u0438\u0448?',
  '\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u043d\u0435 \u0432\u044b\u043a\u043b\u044e\u0447\u0430\u0439 \u0445\u0443\u0438\u043d\u0433\u043b\u0438\u0448',
  '\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u0447\u0442\u043e \u0441 \u0445\u0443\u0438\u043d\u0433\u043b\u0438\u0448\u0435\u043c?',
 ]){
  assert.equal(choose({capabilityId:'huinglish.disable',confidence:0.96,request}).ok,false);
 }
 assert.equal(choose({capabilityId:'huinglish.disable',confidence:0.6,
  request:'\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u0432\u044b\u043a\u043b\u044e\u0447\u0438 \u0445\u0443\u0438\u043d\u0433\u043b\u0438\u0448'}).ok,false);
 const x=choose({capabilityId:'huinglish.disable',confidence:0.95,
  request:'\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u0432\u044b\u043a\u043b\u044e\u0447\u0438 \u0445\u0443\u0438\u043d\u0433\u043b\u0438\u0448'});
 assert.equal(x.ok,true);
 assert.equal(parseHuinglishCommand(x.command)?.type,'off');
});
test('enable and individual lesson require exact subject and lesson number',()=>{
 const x=choose({capabilityId:'english.enable',confidence:0.91,
  request:'\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u0432\u043a\u043b\u044e\u0447\u0438 \u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439'});
 assert.equal(x.ok,true);
 assert.equal(parseEnglishGrammarCommand(x.command)?.type,'on');
 const lesson=choose({capabilityId:'english.lesson',confidence:0.95,
  args:{lesson:4},request:'\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u0437\u0430\u043f\u0443\u0441\u0442\u0438 English \u0443\u0440\u043e\u043a 4'});
 assert.equal(lesson.ok,true,JSON.stringify(lesson));
 assert.deepEqual(parseEnglishGrammarCommand(lesson.command),{type:'lesson',id:4});
 assert.equal(choose({capabilityId:'english.lesson',confidence:0.99,args:{lesson:4},
  request:'\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, English \u0443\u0440\u043e\u043a 5'}).ok,false);
 assert.equal(choose({capabilityId:'english.lesson',confidence:0.99,args:{lesson:888},
  request:'English \u0443\u0440\u043e\u043a 888'}).ok,false);
 assert.equal(choose({capabilityId:'invalid-missing',confidence:0.99,
  request:'English \u0441\u0442\u0430\u0442\u0443\u0441'}).ok,false);
});
test('scope carries translated command only for the original request in target peer',async()=>{
 assert.equal(scoped.PATROL_PEER_ID,2000000011);
 assert.equal(routing.getPatrolScopedNativeCandidate('anything'),null);
 const result=await scoped.runPatrolScopedRequest('native-command-1',async()=>{
  const original='\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u0447\u0442\u043e \u0441 \u0445\u0443\u0438\u043d\u0433\u043b\u0438\u0448\u0435\u043c?';
  const x=choose({capabilityId:'huinglish.status',confidence:0.65,request:original});
  assert.equal(x.ok,true);
  assert.equal(routing.setPatrolScopedNativeCandidate({source:original,candidate:x.command,
   capabilityId:x.capabilityId}),true);
  assert.equal(routing.getPatrolScopedNativeCandidate(original),x.command);
  assert.equal(routing.getPatrolScopedNativeCandidate('other'),null);
  assert.equal(parseHuinglishCommand(routing.getPatrolScopedNativeCandidate(original))?.type,'status');
  return true;
 });
 assert.equal(result.allowed,true);
 assert.equal(result.result,true);
 assert.equal(routing.getPatrolScopedNativeCandidate('anything'),null);
});
test('main app uses verified native catalog, never injects arbitrary model commands',()=>{
 const source=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(source,/const nativeCandidate=getPatrolScopedNativeCandidate\(source\);/u);
 assert.match(source,/const existingNativeCapabilities=patrolNativeCapabilityCatalog\(\);/u);
 assert.match(source,/if\(action==='native_capability'\)/u);
 assert.match(source,/resolvePatrolNativeCapability\(\{/u);
 assert.match(source,/await executePatrolNativeCapability\(\{selected/u);
 assert.match(source,/observe\(\{action,capabilityId:selected.capabilityId,result\}\);\s+continue;/u);
 assert.match(source,/parseHuinglishCommand\(candidate\)/u);
 assert.match(source,/parseEnglishGrammarCommand\(candidate\)/u);
});
test.after(()=>{
 if(previous===undefined)delete process.env.GIGORAVE_DATA_DIR;
 else process.env.GIGORAVE_DATA_DIR=previous;
 rmSync(tmp,{recursive:true,force:true});
});
