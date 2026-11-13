import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import vm from 'node:vm';
import{preparePartyDelivery,markPartyDelivery,completePartyDelivery,buildPartyRequestSignature,createPartyDeliveryQueue,normalizePartyCooldownState,partyDeliveryEventKey,latestPartyRangeReplyTarget}from'../../src/features/events/partyDeliveryCooldown.js';
import{packCompactTelegramEventList}from'../../src/features/events/compactEventListMessages.js';
import{createPublicEventRangeService}from'../../src/features/events/publicEventRange.js';
const start=Date.parse('2026-11-05T10:00:00Z'),hour=3600000;
const event=(id,date='2026-11-06')=>({sourceType:'vk',id,eventDate:date,title:({1:'Экзистентер',2:'Чурч',3:'Ветер'})[id]||'Другая группа',venue:'Вавилон'});
const req=(overrides={})=>({platform:'vk',peerId:'1',messageId:10,fromDate:'2026-11-05',toDate:'2026-11-10',partyPool:'primary',mode:'full',filters:{},...overrides});
const prepare=(state={},request=req(),events=[event(1)],nowMs=start,bypass=false)=>preparePartyDelivery({state,request,events,nowMs,bypass,signature:buildPartyRequestSignature(request)});
function delivered(p,events=[event(1)],complete=true,now=start){
 let state=markPartyDelivery(p.state,p.requestRecord.id,events,now);
 return complete?completePartyDelivery(state,p.requestRecord.id,now):state;
}
test('six hour cooldown does not slide on denied requests',()=>{
 const first=prepare(),saved=delivered(first);
 const denied=prepare(saved,req({messageId:20}),[event(1)],start+5*hour);
 assert.equal(denied.sameRange,true);assert.equal(denied.state.requests.length,1);
 assert.equal(prepare(denied.state,req(),[event(1)],start+6*hour+1).sameRange,false);
});
test('failed and partial deliveries can be retried without repeating delivered cards',()=>{
 const first=prepare({},req(),[event(1),event(2)]);
 assert.equal(prepare(first.state).sameRange,false);
 const partial=delivered(first,[event(1)],false);
 const retry=prepare(partial,req({messageId:20}),[event(1),event(2)]);
 assert.equal(retry.sameRange,false);assert.deepEqual(retry.eligibleEvents.map(e=>e.id),[2]);assert.equal(retry.overlapReplyTarget,10);
});
test('owner bypasses both limits, compact/full do not suppress one another',()=>{
 const state=delivered(prepare());
 assert.equal(prepare(state,req(),[event(1)],start+1,true).eligibleEvents.length,1);
 const compact=prepare(state,req({mode:'compact'}));
 assert.equal(compact.sameRange,false);assert.equal(compact.eligibleEvents.length,1);
 const serialized=normalizePartyCooldownState(JSON.parse(JSON.stringify(state)));
 assert.equal(prepare(serialized).sameRange,true);
});
test('overlap suppresses actual cards and assigns only one previous reply target',()=>{
 const a=prepare({},req({messageId:101,toDate:'2026-11-08'}));let state=delivered(a,[event(1)]);
 const b=prepare(state,req({messageId:202,fromDate:'2026-11-06',toDate:'2026-11-09'}),[event(2)],start+1);state=delivered(b,[event(2)],true,start+1);
 const c=prepare(state,req({messageId:303,toDate:'2026-11-12'}),[event(1),event(3)],start+2);
 assert.deepEqual(c.eligibleEvents.map(e=>e.id),[3]);
 assert.deepEqual(c.targetByEventKey.get(partyDeliveryEventKey(event(3))),[202]);
});
test('another chat or platform has independent limits',()=>{
 const state=delivered(prepare());
 for(const r of [req({peerId:'2'}),req({platform:'telegram'})])assert.equal(prepare(state,r).eligibleEvents.length,1);
});
test('same event from QTickets is recognized using existing deterministic identity',()=>{
 const state=delivered(prepare());
 const e={...event(99),title:event(1).title,sourceType:'qtickets',partyPool:'qtickets'};
 const p=prepare(state,req({partyPool:'qtickets'}),[e],start+1);
 assert.equal(p.eligibleEvents.length,0);
 assert.equal(prepare(state,req({partyPool:'qtickets'}),[{...e,eventDate:'2026-11-07'}],start+1).eligibleEvents.length,1);
});
test('parallel requests serialize per chat and errors release queue',async()=>{
 const run=createPartyDeliveryQueue();let release;const gate=new Promise(r=>release=r),seen=[];
 const one=run('vk:1',async()=>{seen.push('one');await gate;throw Error('send failed');}).catch(()=>{});
 const two=run('vk:1',async()=>seen.push('two'));
 await run('vk:2',async()=>seen.push('other'));assert.deepEqual(seen,['one','other']);release();await Promise.all([one,two]);assert.deepEqual(seen,['one','other','two']);
});
test('compact chunks expose only completed cards for per-send persistence',()=>{
 const cards=[1,2,3].map(id=>({text:('Card '+id+' ').repeat(100),event:event(id)}));
 const parts=packCompactTelegramEventList(cards,'Heading',{limit:1000,trackEvents:true,platform:'vk'});
 assert.equal(parts.length,3);assert.deepEqual(parts[0].completedEvents.map(e=>e.id),[1]);assert.deepEqual(parts.flatMap(p=>p.completedEvents).map(e=>e.id),[1,2,3]);
});
test('interleaved live record callbacks reload latest shared state',async()=>{
 const source=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const a=source.indexOf('async function beginPartyDeliveryCooldown('),b=source.indexOf('\nfunction partyReplyTargets',a);
 let state={};const sandbox={preparePartyDelivery,markPartyDelivery,completePartyDelivery,buildPartyRequestSignature,latestPartyRangeReplyTarget,Date,
  partyCooldownRequestContext:(context,range,pool,filters)=>req({peerId:context.peerId,...range,partyPool:pool,filters:filters||{}}),
  partyCooldownSettings:()=>({deliveryHours:6,rangeHours:6}),loadPartyDeliveryCooldownState:()=>structuredClone(state),
  savePartyDeliveryCooldownState:s=>(state=structuredClone(s)),isOwnerContext:c=>c.owner,formatPartyCooldownHours:String};
 vm.createContext(sandbox);vm.runInContext(source.slice(a,b)+'\nthis.begin=beginPartyDeliveryCooldown;',sandbox);
 const first=await sandbox.begin({peerId:'1',send:async()=>{}},{},'primary',{},[event(1)]);
 const second=await sandbox.begin({peerId:'2',send:async()=>{}},{},'primary',{},[event(2)]);
 first.record(event(1));second.record(event(2));first.complete();second.complete();
 assert.equal(state.requests.length,2);assert.equal(state.requests.every(r=>r.deliveredKeys.length===1&&r.status==='complete'),true);
 const owner=await sandbox.begin({peerId:'1',owner:true,send:async()=>{}},{},'primary',{},[event(1)]);
 assert.equal(owner.eligibleEvents.length,1);
});
const svc=createPublicEventRangeService({timeZone:'Europe/Moscow',now:()=>new Date('2026-11-05T12:00:00+03:00')});
test('explicit year is retained in mixed past/future intent',()=>{
 const r=svc.parsePublicEventsRangeCommand('прошедшие и будущие тусы 2027');assert.equal(r.fromDate,'2027-01-01');assert.equal(r.toDate,'2027-12-31');assert.match(r.notice,/только будущие/);
});
test('past relative periods cannot become future month or year',()=>{
 for(const text of ['тусы прошлый месяц','тусы прошлую неделю','прошедшие тусы','тусы прошлый год'])assert.equal(svc.parsePublicEventsRangeCommand(text).pastOnly,true,text);
});
test('six hour defaults stay unchanged',async()=>{
 const m=await import('../../src/features/events/partyDeliveryCooldown.js');assert.equal(m.DEFAULT_PARTY_DELIVERY_COOLDOWN_HOURS,6);assert.equal(m.DEFAULT_PARTY_RANGE_COOLDOWN_HOURS,6);
});
