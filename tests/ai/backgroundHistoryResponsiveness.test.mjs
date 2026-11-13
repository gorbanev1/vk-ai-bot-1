
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getLocalDateString} from '../../src/shared/date.js';
import {resolveHierarchyMessageStateKey} from '../../src/features/ai/hierarchyMessageIdentity.js';
import {CALENDAR_SUMMARY_SLICE_SLOTS,calendarSummarySliceBounds,calendarSummarySliceForTimestamp,calendarSummarySliceIsClosed} from '../../src/features/ai/calendarSummarySlices.js';
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
const start=app.indexOf('function* collectUnpaidCalendarMessageSteps(');
const end=app.indexOf('\nconst CALENDAR_SUMMARY_MAX_SLICES_PER_MAINTENANCE',start);
function collector(history,states){
 const aliases=[]; let calendarCalls=0;
 const deps={
 filterSummaryMessages: x=>x,loadLinkedSummaryHistory:()=>history,getHierarchyMessageStates:()=>states,
 hierarchyMessageKey:m=>m.hierarchyStateKey||m.key,hierarchyMessageContentHash:m=>m.hash,resolveHierarchyMessageStateKey,
 calendarMessageDateKey:m=>{calendarCalls++;return getLocalDateString(new Date(m.createdAt*1000),'Europe/Moscow');},
 calendarSummarySliceForTimestamp,calendarSummarySliceIsClosed,botTimeZone:'Europe/Moscow',
 recoveredMessageCanAliasPaidState:(m,paid)=>paid.some(p=>p.sourcePeerId!==m.sourcePeerId),
 saveHierarchyMessageState:a=>aliases.push(a),setImmediate
 };
 const functions=new Function(...Object.keys(deps),app.slice(start,end)+'\nreturn {sync:collectUnpaidCalendarMessages,async:collectUnpaidCalendarMessagesAsync};')(...Object.values(deps));
 return {...functions,aliases,calendarCalls:()=>calendarCalls};
}
const now=new Date('2026-10-26T12:30:00Z');
const time=Date.parse('2026-10-26T09:00:00Z')/1000;
test('paid history skips calendar work; full async scan yields to incoming work',async()=>{
 const history=Array.from({length:20000},(_,i)=>({key:'m'+i,createdAt:time,hash:'h'+i}));
 const c=collector(history,history.map(m=>({messageKey:m.key,contentHash:m.hash})));
 let responsive=false;setImmediate(()=>{responsive=true;});
 const result=await c.async(6,now);
 assert.equal(result.historyCount,history.length);assert.equal(result.paidCount,history.length);
 assert.equal(result.groups.size,0);assert.equal(c.calendarCalls(),0);assert.equal(responsive,true);
});
test('sync and background scans preserve unpaid messages, aliases and current-slice gates',async()=>{
 const history=[
 {key:'paid',hash:'p',sourcePeerId:6,createdAt:time},
 {key:'repeat',hash:'p',sourcePeerId:6,createdAt:time},
 {key:'alias',hash:'p',sourcePeerId:7,createdAt:time},
 {key:'new',hash:'n',sourcePeerId:6,createdAt:time},
 {key:'open',hash:'o',sourcePeerId:6,createdAt:Math.floor(now.getTime()/1000)}
 ];
 const states=[{messageKey:'paid',contentHash:'p',nodeKey:'paid-node',sourcePeerId:6}];
 for(const includeOpenCurrentSlice of [false,true]){
  const a=collector(history,states),b=collector(history,states);
  const result=await a.async(6,now,{includeOpenCurrentSlice});
  assert.deepEqual(result,b.sync(6,now,{includeOpenCurrentSlice}));
  assert.equal(result.aliases,1);assert.equal(a.aliases[0].nodeKey,'paid-node');
  assert.equal([...result.groups.values()].flatMap(g=>g.messages).length,includeOpenCurrentSlice?3:2);
 }
});
test('cached calendar lookup matches original bounds across DST, zones and every boundary',()=>{
 for(const zone of ['Europe/Moscow','Europe/Berlin','America/New_York'])
 for(const day of ['2026-03-08','2026-03-29','2026-10-25','2026-11-01']){
  const bounds=CALENDAR_SUMMARY_SLICE_SLOTS.map(slot=>({...slot,...calendarSummarySliceBounds(day,slot,zone)}));
  for(const row of bounds)for(const ts of [row.startAt-1,row.startAt,row.endAt-1,row.endAt]){
   const expected=bounds.find(b=>ts>=b.startAt&&ts<b.endAt)||null;
   assert.deepEqual(calendarSummarySliceForTimestamp(ts,day,zone),expected);
  }
  const row=calendarSummarySliceForTimestamp(bounds[0].startAt,day,zone);row.startAt=0;
  assert.equal(calendarSummarySliceForTimestamp(bounds[0].startAt,day,zone).startAt,bounds[0].startAt);
 }
});
test('style cycle reads each peer once and checks every own message without truncation',async()=>{
 const start=app.indexOf('async function runBatchedStylePersonalizationJobs(');
 const end=app.indexOf('stylePersonalizationJobRunning = false;',start)+'stylePersonalizationJobRunning = false;'.length;
 const code=app.slice(start,end)+'\n    }\n}';
 const history=Array.from({length:3000},(_,i)=>({senderId:i%3+1,createdAt:i,text:'message '+i}));
 const reads=[],checked=[];
 const deps={setImmediate,console,PERSONALIZATION_ACTIVE_LOOKBACK_SECONDS:86400,STYLE_PERSONALIZATION_BATCH_MESSAGES:500,
 getParticipantPairsBetween:()=>[6,7].flatMap(peerId=>[1,2,3].map(userId=>({peerId,userId}))),
 getAllMessages:peerId=>{reads.push(peerId);return history;},
 getStyleBatchState:()=>({styleText:''}),getParticipantStyle:()=>({profileText:''}),getCommunicationStyleExamples:()=>[{}],
 messageIsAfterCursor:m=>{checked.push(m);return false;}
 };
 const run=new Function(...Object.keys(deps),'let stylePersonalizationJobRunning=false;\n'+code+'\nreturn runBatchedStylePersonalizationJobs;')(...Object.values(deps));
 let responsive=false;setImmediate(()=>{responsive=true;});await run();
 assert.deepEqual(reads,[6,7]);assert.equal(checked.length,6000);assert.equal(responsive,true);
});
