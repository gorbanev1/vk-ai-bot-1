import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildChtivoReplyForward} from '../../src/features/chtivo/chtivoReplyTarget.js';
import {createVkIncomingReplyContext} from '../../src/shared/incomingReplyTransport.js';
import {guardPartyContext,capturePartyRequest} from '../../src/features/events/partyStopRouting.js';
import {
 buildPartyRequestSignature,completePartyDelivery,markPartyDelivery,
 partyCooldownReplyFields,preparePartyDelivery,latestPartyRangeReplyTarget
} from '../../src/features/events/partyDeliveryCooldown.js';

const peerId=2_000_000_010,earlierCmid=2_049_696;
function vkProbe() {
 const calls=[];
 const raw={
  platform:'vk',peerId,conversationMessageId:2_049_920,
  async send(payload,params){calls.push({method:'send',payload,params});return {conversationMessageId:2_049_921};},
  async reply(payload,params){calls.push({method:'reply',payload,params});return {conversationMessageId:2_049_922};}
 };
 const wrapped=createVkIncomingReplyContext(raw);
 capturePartyRequest(wrapped);
 return {context:guardPartyContext(wrapped),calls};
}
function isTrueVkReply(calls,expectedCmid){
 assert.equal(calls.length,1);
 const [call]=calls;
 assert.equal(call.method,'send','must use old-message forward instead of default reply to current command');
 assert.equal(call.params?.reply_to,undefined,'conversation_message_id must never be passed as global reply_to');
 assert.deepEqual(JSON.parse(call.params.forward),{
  conversation_message_ids:expectedCmid,peer_id:peerId,is_reply:true,
 });
 assert.equal(call.params.forward,buildChtivoReplyForward(peerId,expectedCmid),
  'match exactly the working «Чтиво»/HuInglish VK reply construction');
 assert.equal('replyToConversationMessageId' in call.payload,false);
 assert.equal('replyWithForwardConversationMessageId' in call.payload,false);
}
function candidate(id,date='2026-11-07',partyPool='primary'){
 return {sourceType:'vk',id,eventDate:date,title:'Концерт '+id,partyPool,venue:'Клуб'};
}
const start=Date.parse('2026-11-07T16:00:00.000Z');
const request=(cmid,from='2026-11-07',to='2026-11-07',pool='all')=>({
 platform:'vk',peerId:String(peerId),messageId:cmid,fromDate:from,toDate:to,
 partyPool:pool,mode:'full',filters:{},
});
function prepared(state,requestData,events,nowMs=start){
 return preparePartyDelivery({
  state,request:requestData,events,nowMs,deliveryCooldownHours:6,
  rangeCooldownHours:requestData.partyPool==='all'?24:6,
  signature:buildPartyRequestSignature(requestData),
 });
}
function finished(p,events,at=start){
 return completePartyDelivery(markPartyDelivery(p.state,p.requestRecord.id,events,at),p.requestRecord.id,at);
}

test('exact prior VK request cmid creates visible native reply like Chitvo, not a standalone message',async()=>{
 const {context,calls}=vkProbe();
 await context.send({message:'Этот диапазон уже выдавался в последние 24 часа.',
  ...partyCooldownReplyFields(earlierCmid)});
 isTrueVkReply(calls,earlierCmid);
 assert.match(calls[0].payload.message,/24 часа/u);
});
test('stored same-range reply is directed to the ORIGINAL request rather than the new request',async()=>{
 const original=request(earlierCmid);
 const events=[candidate(12),candidate(13,'2026-11-07','secondary')];
 const first=prepared({},original,events,start);
 const state=finished(first,events,start);
 const newCommand=request(earlierCmid+224);
 const duplicate=prepared(state,newCommand,events,start+50*60_000);
 assert.equal(duplicate.sameRange,true);
 assert.deepEqual(duplicate.eligibleEvents,[]);
 assert.equal(latestPartyRangeReplyTarget(duplicate),earlierCmid);
 const probe=vkProbe();
 await probe.context.send({message:'Этот диапазон уже выдавался',...partyCooldownReplyFields(latestPartyRangeReplyTarget(duplicate))});
 isTrueVkReply(probe.calls,earlierCmid);
 assert.notEqual(JSON.parse(probe.calls[0].params.forward).conversation_message_ids,newCommand.messageId);
});
test('partly overlapping daily/weekly request replies to the original range and sends only fresh cards',async()=>{
 const previous=request(earlierCmid);
 const alreadySent=candidate(20);
 const state=finished(prepared({},previous,[alreadySent]),[alreadySent]);
 const current=request(earlierCmid+350,'2026-11-07','2026-11-13');
 const next=prepared(state,current,[alreadySent,candidate(21,'2026-11-09','secondary')],start+3*60*60_000);
 assert.equal(next.sameRange,false);
 assert.equal(next.blockedEvents,1);
 assert.deepEqual(next.eligibleEvents.map(x=>x.id),[21]);
 assert.equal(next.overlapReplyTarget,earlierCmid);
 const probe=vkProbe();
 await probe.context.send({message:'Часть подборки уже была отправлена. Показываю новые события.',
  ...partyCooldownReplyFields(next.overlapReplyTarget)});
 isTrueVkReply(probe.calls,earlierCmid);
});
test('new cards can reply to the previously served range without sending duplicate cards',async()=>{
 const previous=request(earlierCmid),sent=candidate(30,'2026-11-07');
 const done=finished(prepared({},previous,[sent]),[sent]);
 const newEvent=candidate(31,'2026-11-07');
 const result=prepared(done,request(earlierCmid+100,'2026-11-07','2026-11-08'),[newEvent],start+60*60_000);
 assert.equal(result.eligibleEvents.length,1);
 assert.equal(result.replyGroups[0]?.messageId,earlierCmid);
 const probe=vkProbe();
 await probe.context.send({message:'🎸 '+newEvent.title,
  ...partyCooldownReplyFields(result.replyGroups[0]?.messageId)});
 isTrueVkReply(probe.calls,earlierCmid);
});
test('invalid/unavailable reference degrades to normal reply, never an invalid forward',async()=>{
 assert.deepEqual(partyCooldownReplyFields(0),{});
 assert.deepEqual(partyCooldownReplyFields(-1),{});
 assert.deepEqual(partyCooldownReplyFields('not-a-number'),{});
 const probe=vkProbe();
 await probe.context.send({message:'Нет сохранённого сообщения',...partyCooldownReplyFields(0)});
 assert.equal(probe.calls[0].method,'reply');
 assert.equal(probe.calls[0].params?.forward,undefined);
});
test('all public party paths, including duplicate notice, compact cards, main/secondary and Qtickets, use cmid forward helper',()=>{
 const src=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(src,/message: 'Этот диапазон уже выдавался в последние 24 часа\. Повторная выдача будет доступна позже\.',\s*\.\.\.partyCooldownReplyFields\(partyDelivery\.sameRangeReplyTarget\)/u);
 assert.match(src,/function partyReplyFields[\s\S]*?\?\s*partyCooldownReplyFields\(targetId\)/u);
 assert.match(src,/message: 'Часть подборки уже отправлена[\s\S]*?\.\.\.partyCooldownReplyFields\(target\)/u);
 assert.match(src,/Все найденные карточки за период[\s\S]{0,270}partyCooldownReplyFields\(partyDelivery\.overlapReplyTarget\)/u);
 assert.match(src,/Все найденные карточки QTickets за период[\s\S]{0,270}partyCooldownReplyFields\(partyDelivery\.overlapReplyTarget\)/u);
 assert.match(src,/partyCooldownReplyFields\(target\)/u);
 assert.doesNotMatch(src.slice(src.indexOf('async function beginPartyDeliveryCooldown('),
   src.indexOf('const {',src.indexOf('async function beginPartyDeliveryCooldown('))),/replyToConversationMessageId:\s*target/u);
});
