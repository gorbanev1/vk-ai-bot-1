import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {patrolConversationFrame,patrolInitialPhoto,patrolShouldUseConversationEntry,completePatrolSilently} from '../../src/features/ai/vkPatrolConversationIntent.js';
import {parsePatrolAgentPlan} from '../../src/features/ai/vkPatrolAgentProtocol.js';
const photo={type:'photo'};
test('a captionless current meme is not automatically inspected',()=>{
 assert.equal(patrolInitialPhoto({raw:{attachments:[photo]},currentCmid:284185,
  thread:[{cmid:284170,attachments:[photo]}]}),null);
 assert.deepEqual(patrolInitialPhoto({raw:{attachments:[photo]},currentCmid:284185,visualQuestion:true}),{cmid:284185,photoIndex:0});
});
test('sarcastic text does not automatically inspect an old picture',()=>{
 assert.equal(patrolInitialPhoto({currentCmid:284197,thread:[{cmid:284185,attachments:[photo]}]}),null);
});
test('explicit visual question selects nearest actual ancestor, not neighboring chat',()=>{
 assert.deepEqual(patrolInitialPhoto({currentCmid:20,visualQuestion:true,thread:[
  {cmid:10,attachments:[photo]},{cmid:15,attachments:[photo]},{cmid:20,attachments:[]}]}),{cmid:15,photoIndex:0});
});
test('roles keep laughing author distinct from Oleg and quoted bot',()=>{
 const f=patrolConversationFrame({from_id:1022951909,conversation_message_id:284197,
 reply_message:{from_id:-233007447,conversation_message_id:284192}},
 {chainComplete:true,thread:[{cmid:284185,senderId:181824119},{cmid:284192,senderId:-233007447}]});
 assert.equal(f.speakerId,1022951909);assert.equal(f.replyRecipientId,-233007447);
 assert.equal(f.replyBranch[0].senderId,181824119);assert.equal(f.threadComplete,true);
});
test('silence is a completed decision with no fabricated output',async()=>{
 const scope={},events=[],memory={summary:(...x)=>events.push(['summary',...x])};
 assert.equal(await completePatrolSilently({scope,trace:(...x)=>events.push(x),memory,turnId:'t'}),true);
 assert.equal(scope.finalStatus,'silent');assert.deepEqual(events,[['silent',{reason:'no conversational reply needed'}]]);
});
test('silence cannot claim to be execution of a task or clarification',()=>{
 for(const intent of ['task','visual_question','correction',undefined])
  assert.equal(parsePatrolAgentPlan(JSON.stringify({action:'silent',intent,confidence:0.9})).ok,false);
 assert.equal(parsePatrolAgentPlan('{"action":"silent","intent":"social_reaction","confidence":0.8}').ok,true);
 assert.equal(parsePatrolAgentPlan('{"action":"silent","intent":"social_reaction","confidence":0.2}').ok,false);
});
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
const gate=app.slice(app.indexOf('async function handleRequest('),app.indexOf('    const normalizedIncomingRequest',app.indexOf('async function handleRequest(')))+'return "native";}';
async function route({enabled=true,scope={},text='',synth='Опиши изображение',handled=true}={}){
 const calls=[];const raw={text,attachments:[photo]};
 const sandbox={patrolActiveScope:()=>scope,isPatrolPeer:()=>true,isPatrolAdaptiveEnabled:()=>enabled,
 patrolShouldUseConversationEntry,getRawContext:()=>raw,getVkRawMessage:x=>x,
 handlePatrolAdaptive:async(...args)=>{calls.push(args);return handled;}};
 vm.createContext(sandbox);vm.runInContext(gate+';this.run=handleRequest;',sandbox);
 const result=await sandbox.run({peerId:2000000011,text},synth);return {result,calls};
}
test('legacy synthetic describe-image prompt never becomes the user instruction',async()=>{
 const r=await route();assert.equal(r.calls.length,1);assert.equal(r.calls[0][1],'');
 assert.equal(r.calls[0][3].conversationEntry,true);assert.equal(r.result,undefined);
});
test('explicit question is preserved in the same conversation route',async()=>{
 const r=await route({text:'Объясни этот мем'});assert.equal(r.calls[0][1],'Объясни этот мем');
});
test('native delegation, disabled mode and already planned requests never reenter',async()=>{
 for(const opts of [{enabled:false},{scope:{adaptive:false}},{scope:{delegatedNative:true}},{scope:{conversationAttempted:true}}]){
  const r=await route(opts);assert.equal(r.calls.length,0);assert.equal(r.result,'native');
 }
});
