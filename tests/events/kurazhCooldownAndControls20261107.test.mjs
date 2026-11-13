import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 buildPartyRequestSignature,preparePartyDelivery,markPartyDelivery,completePartyDelivery,
 partyDeliveryEventKey
} from '../../src/features/events/partyDeliveryCooldown.js';
import {parseAutoSummaryCommand} from '../../src/features/ai/autoSummaryRouting.js';
import {parseChatFunctionToggle,chatFunctionsStateKey,normalizeChatFunctionsState,partyDisabledResponse} from '../../src/features/routing/chatFunctionToggles.js';

const epoch=Date.parse('2026-11-07T09:00:00Z'),hour=3600000;
const item=(id,date='2026-11-07',pool='primary')=>({
 id,sourceType:'vk',eventDate:date,partyPool:pool,title:'Событие '+id,
 venue:'Фестивальник'
});
const request=(pool='all',from='2026-11-07',to='2026-11-07',other={})=>({
 platform:'vk',peerId:'2000000010',messageId:123,partyPool:pool,
 fromDate:from,toDate:to,filters:{},mode:'full',...other
});
function prepare(state,req,events,now=epoch,opts={}){
 return preparePartyDelivery({state,events,nowMs:now,request:req,
  signature:buildPartyRequestSignature(req),rangeCooldownHours:req.partyPool==='all'?24:6,
  deliveryCooldownHours:6,...opts});
}
function sent(result,events,now=epoch){
 return completePartyDelivery(markPartyDelivery(result.state,result.requestRecord.id,events,now),result.requestRecord.id,now);
}
test('«Где кураж»: same range is blocked for 24h for every person, with the original reply ID',()=>{
 const req=request('all'),events=[item(1),item(2,undefined,'secondary')];
 const first=prepare({},req,events);
 assert.equal(first.eligibleEvents.length,2);
 const state=sent(first,events);
 const repeat=prepare(state,{...req,messageId:999,senderId:999},events,epoch+12*hour);
 assert.equal(repeat.sameRange,true);
 assert.equal(repeat.previousSameRange[0].messageId,123);
 assert.deepEqual(repeat.eligibleEvents,[]);
 assert.equal(repeat.state.requests.length,1);
 assert.equal(prepare(state,{...req,messageId:999},events,epoch+24*hour+1).sameRange,false);
});
test('«тусы сегодня» then «где кураж на неделе» 3h later: already shown primary hidden, secondary new, reply points at first request',()=>{
 const old=request('primary','2026-11-07','2026-11-07',{messageId:101});
 const one=item(1),two=item(2,'2026-11-08','secondary');
 const earlier=prepare({},old,[one]);
 const state=sent(earlier,[one],epoch);
 const current=prepare(state,request('all','2026-11-07','2026-11-13',{messageId:202}),[one,two],epoch+3*hour);
 assert.equal(current.sameRange,false);
 assert.deepEqual(current.eligibleEvents.map(x=>x.id),[2]);
 assert.equal(current.blockedEvents,1);
 assert.equal(current.overlapReplyTarget,101);
 // The notice replies to request 101; a newly discovered next-day card is sent normally.
 assert.deepEqual(current.replyGroups.map(g=>g.messageId),[0]);
});
test('«второстепенные тусы» then «где кураж» still cannot send same card, including another format',()=>{
 const earlier=prepare({},request('secondary',undefined,undefined,{messageId:301}),[item(7,'2026-11-07','secondary')]);
 const state=sent(earlier,[item(7,'2026-11-07','secondary')]);
 const after=prepare(state,request('all',undefined,undefined,{mode:'compact',messageId:304}),
  [item(7,'2026-11-07','secondary'),item(8)],epoch+hour);
 assert.deepEqual(after.eligibleEvents.map(x=>x.id),[8]);
 assert.equal(after.overlapReplyTarget,301);
});
test('6 hours does not slide forward when a denied request occurs; another chat is independent',()=>{
 const original=request('all'),e=[item(1)];
 const state=sent(prepare({},original,e),e);
 const again=prepare(state,{...original,messageId:200},e,epoch+3*hour);
 assert.equal(again.sameRange,true);
 assert.equal(again.state.requests.length,1);
 const differentChat=prepare(state,{...original,peerId:'2000000006'},e,epoch+hour);
 assert.equal(differentChat.eligibleEvents.length,1);
});
test('owner requests for aggregate explicitly do NOT bypass shared cooldown and uses record per card only',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/bypass: normalizedPool !== 'all' && isOwnerContext\(context\)/u);
 assert.match(app,/rangeCooldownHours: normalizedPool === 'all' \? 24 : settings.rangeHours/u);
 assert.match(app,/partyDelivery\.eligibleEvents/u);
 assert.match(app,/partyDelivery\?\.record\?\.\(event\)/u);
 assert.match(app,/partyDelivery\.overlapReplyTarget/u);
 assert.ok(app.includes("runPartyDeliverySerial(partyRequestPlatform(context)+':'+partyRequestPeerId(context)"));
});
test('toggle routes are guarded in groups, stored per chat, and stats scheduler filters disabled targets',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/handleChatFunctionToggle\(context,directText\)/u);
 assert.match(app,/handleChatFunctionToggle\(context,originalText \|\| text\)/u);
 assert.match(app,/if\(!isChatFunctionEnabled\(context,'parties'\)\)/u);
 assert.match(app,/\.filter\(target=>isChatFunctionEnabledForPeer\(target.platform,target.externalPeerId,'statistics'\)\)/u);
 assert.match(app,/if\(!await isChatFunctionManager\(context\)\)/u);
 assert.deepEqual(parseChatFunctionToggle('Гигорейв, тусы выкл'),{kind:'parties',action:'disable'});
 assert.notEqual(chatFunctionsStateKey('vk',2000000010),chatFunctionsStateKey('telegram',2000000010));
});
test('«авторезюме вкл» resumes saved schedule; a replacement has its own options',()=>{
 const resume=parseAutoSummaryCommand('Гигорейв авторезюме вкл');
 assert.equal(resume.matched,true);assert.equal(resume.resume,true);
 assert.equal(parseAutoSummaryCommand('авторезюме включить').resume,true);
 assert.equal(parseAutoSummaryCommand('авторезюме выкл').action,'disable');
 for(const entry of [
  ['авторезюме 12:00 дневное',['12:00'],true,false],
  ['авторезюме 12:00 13:00 15:00 18:00 дневное недельное',['12:00','13:00','15:00','18:00'],true,true],
 ]){
  const parsed=parseAutoSummaryCommand(entry[0]);
  assert.deepEqual(parsed.schedule,entry[1]);assert.equal(parsed.preferences.dailyEnabled,entry[2]);
  assert.equal(Boolean(parsed.preferences.weeklyEnabled),entry[3]);
 }
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/parsedCommand\.resume \? \(current\?\.mode\|\|'full'\)/u);
 assert.match(app,/const replacingSchedule=Array\.isArray\(parsedCommand\.schedule\)/u);
 assert.match(app,/normalizeAutoSummaryPreferences\(parsedCommand\.preferences\|\|\{\}\)/u);
 assert.match(app,/autoSummaryCommandExamples/u);
});

test('chat owner toggles parties and statistics independently without affecting another chat (real application handlers)',async()=>{
 const vm=await import('node:vm');
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const begin=app.indexOf('function loadChatFunctionSettings(');
 const end=app.indexOf('function partyRequestMessageId(',begin);
 assert.ok(begin>=0&&end>begin);
 const state=new Map(),msgs=[],admins=new Set();
 const environment={
  normalizeChatFunctionsState,chatFunctionsStateKey,parseChatFunctionToggle,
  getMaintenanceState:key=>state.has(key)?{details:state.get(key)}:null,
  setMaintenanceState:(key,{details})=>state.set(key,details),
  isOwnerContext:ctx=>ctx.senderId===42,
  isPrivateContext:ctx=>Boolean(ctx.private),
  getRawContext:ctx=>ctx,
  partyRequestPlatform:ctx=>ctx.platform,
  partyRequestPeerId:ctx=>String(ctx.peerId),
  partyDisabledResponse,
  withProviderDeadline:promise=>promise,
  getVkGroupIdForClient:()=>233007447,
  getActiveVkConnection:()=>({client:{api:{messages:{getConversationMembers:async()=>({items:[{member_id:31,is_admin:true}]})}}}}),
  primaryVk:null,telegramBot:null,console,
 };
 vm.createContext(environment);
 vm.runInContext(app.slice(begin,end)+'\nthis.toggle=handleChatFunctionToggle;this.enabled=isChatFunctionEnabled;',environment);
 const ctx={platform:'vk',peerId:2000000010,senderId:42,private:false,send:async x=>msgs.push(x)};
 assert.equal(await environment.toggle(ctx,'Гигорейв тусы выкл'),true);
 assert.equal(environment.enabled(ctx,'parties'),false);
 assert.equal(environment.enabled(ctx,'statistics'),true);
 assert.equal(environment.enabled({...ctx,peerId:2000000006},'parties'),true);
 assert.match(msgs.at(-1),/тусы вкл/u);
 assert.equal(await environment.toggle({...ctx,senderId:31},'статистика выкл'),true);
 assert.equal(environment.enabled(ctx,'statistics'),false);
 assert.equal(await environment.toggle({...ctx,senderId:7},'статистика вкл'),true);
 assert.equal(environment.enabled(ctx,'statistics'),false,'ordinary participant cannot enable');
 assert.equal(await environment.toggle(ctx,'статистика включить'),true);
 assert.equal(environment.enabled(ctx,'statistics'),true);
 assert.equal(await environment.toggle(ctx,'тусы вкл'),true);
 assert.equal(environment.enabled(ctx,'parties'),true);
});
