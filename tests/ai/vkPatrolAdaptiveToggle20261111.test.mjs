import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'patrol-toggle-'));
const old=process.env.GIGORAVE_DATA_DIR;
process.env.GIGORAVE_DATA_DIR=temp;
const mod=await import('../../src/features/ai/vkPatrolAdaptive.js?toggle=20261111');
const target=mod.PATROL_PEER_ID;
const parse=mod.parsePatrolAdaptiveToggleCommand;
test('adaptive is on by default only for configured target chat',()=>{
 assert.equal(target,2000000011);
 assert.equal(mod.isPatrolAdaptiveEnabled(target),true);
 for(const id of [2000000006,2000000038,2000000002,2000000003,123456])
  assert.equal(mod.isPatrolAdaptiveEnabled(id),false);
});
test('recognizes explicit on, off and status commands without wake word',()=>{
 assert.deepEqual(parse('\u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0432\u043a\u043b'),{action:'enable'});
 assert.deepEqual(parse('\u0410\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0412\u042b\u043a\u043b'),{action:'disable'});
 assert.deepEqual(parse('\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0432\u043a\u043b\u044e\u0447\u0438\u0442\u044c'),{action:'enable'});
 assert.deepEqual(parse('Gigorave: \u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0432\u044b\u043a\u043b\u044e\u0447\u0438\u0442\u044c'),{action:'disable'});
 assert.deepEqual(parse('\u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0441\u0442\u0430\u0442\u0443\u0441'),{action:'status'});
 assert.deepEqual(parse('\u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c'),{action:'status'});
 for(const phrase of ['\u043f\u0438\u0448\u0438','\u043a\u0430\u043a \u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442 \u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0432\u043a\u043b?',
  '\u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0432\u043a\u043b \u0432\u0447\u0435\u0440\u0430']){
  assert.equal(parse(phrase),null);
 }
});
test('toggle persists across invocations and cannot switch another peer',()=>{
 const state=mod.setPatrolAdaptiveEnabled(target,false,{actorId:123});
 assert.equal(state.enabled,false);
 assert.equal(mod.isPatrolAdaptiveEnabled(target),false);
 assert.equal(mod.isPatrolAdaptiveEnabled(2000000038),false);
 const file=join(temp,'vk-patrol-adaptive','adaptive-mode.json');
 assert.equal(JSON.parse(readFileSync(file,'utf8')).enabled,false);
 assert.throws(()=>mod.setPatrolAdaptiveEnabled(2000000038,true,{actorId:123}),/only be configured/);
 mod.setPatrolAdaptiveEnabled(target,true,{actorId:123});
 assert.equal(mod.isPatrolAdaptiveEnabled(target),true);
});
test('VK toggle executes before adaptive scope and the planner is gated by persisted setting',()=>{
 const source=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const entry=source.indexOf('async function handleVkIncomingMessageCore(');
 const scoped=source.indexOf('runPatrolScopedRequest(context.conversationMessageId',entry);
 const command=source.indexOf('parsePatrolAdaptiveToggleCommand(',entry);
 assert.ok(command>entry&&command<scoped);
 assert.ok(source.includes('if(isPatrolPeer(context.peerId)&&isPatrolAdaptiveEnabled(context.peerId)'));
 assert.ok(source.includes('if(isPatrolAdaptiveEnabled(context.peerId)&&patrolActiveScope()?.adaptive!==false'));
 assert.ok(source.includes('if(!await isChatFunctionManager(context))'));
});
test.after(()=>{
 if(old===undefined)delete process.env.GIGORAVE_DATA_DIR;
 else process.env.GIGORAVE_DATA_DIR=old;
 rmSync(temp,{recursive:true,force:true});
});
