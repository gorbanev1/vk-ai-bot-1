import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
const start=app.indexOf('async function sendQticketsEventsForRangeCore(');
const end=app.indexOf('\nfunction formatQticketsScrapeResult',start);
test('QTickets passes agent filters to the existing selector before limiting and cooldown recording',async()=>{
 const rows=Array.from({length:205},(_,i)=>({id:i,price:i===204?0:100,venue:i===204?'target':'other'}));
 let cooldownFilters,delivered,selectorSeen;
 const deps={
  guardPartyContext:x=>x,partyRequestStopped:()=>false,restrictPublicEventsToFuture:x=>x,
  createQticketsRollingRange:()=>({}),getLocalDateString:()=> '2026-11-12',botTimeZone:'Europe/Moscow',
  hasQticketsPriceLimit:()=>true,getQticketsUpcomingEvents:()=>rows,qticketsEventOverlapsRange:()=>true,
  qticketsEventHasConflictingCity:()=>false,qticketsEventMatchesPriceLimit:(e,p)=>e.price<=p,
  comparePublicEventChronology:(a,b)=>a.id-b.id,
  selectEventsForSearchFilters:async(events,filters)=>{selectorSeen=filters;return events.filter(e=>e.venue===filters.venueQuery);},
  beginPartyDeliveryCooldown:async(c,r,p,filters,events)=>{cooldownFilters=filters;return {eligibleEvents:events,blockedEvents:0};},
  sendCompactPublicEventList:async(c,events)=>{delivered=events.map(x=>x.event);return {sentCount:1};},
  sendPublicEventMessages:async(c,events)=>{delivered=events;return {sentCount:events.length};},
  console:{log(){}}
 };
 const run=new Function(...Object.keys(deps),app.slice(start,end)+';return sendQticketsEventsForRangeCore;')(...Object.values(deps));
 const filters={venueQuery:'target',venueKeys:['target'],tags:['rock'],maxPrice:0};
 const result=await run({send:async()=>{}},{fromDate:'2026-11-12',kind:'week'},'patrol-adaptive',{filters,compact:true});
 assert.equal(selectorSeen,filters);assert.equal(delivered.length,1);assert.equal(delivered[0].id,204);
 assert.equal(cooldownFilters.maxPrice,0);assert.deepEqual(cooldownFilters.tags,['rock']);assert.equal(result.events,1);
});
