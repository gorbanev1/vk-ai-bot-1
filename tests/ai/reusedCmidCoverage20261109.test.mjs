import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveHierarchyMessageStateKey} from '../../src/features/ai/hierarchyMessageIdentity.js';
import {getLocalDateString} from '../../src/shared/date.js';
import {calendarSummarySliceForTimestamp,calendarSummarySliceIsClosed} from '../../src/features/ai/calendarSummarySlices.js';
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
const start=app.indexOf('function* collectUnpaidCalendarMessageSteps(');
const end=app.indexOf('const CALENDAR_SUMMARY_MAX_SLICES_PER_MAINTENANCE',start);
assert.ok(start>0 && end>start);
function scanner(history,paid){
 const inserted=[];
 const defaults={
  filterSummaryMessages:x=>x,loadLinkedSummaryHistory:()=>history,getHierarchyMessageStates:()=>paid,
  resolveHierarchyMessageStateKey,
  hierarchyMessageKey:m=>m.hierarchyStateKey||m.key,
  hierarchyMessageContentHash:m=>m.hash,
  recoveredMessageCanAliasPaidState:(m,states)=>states.some(x=>x.sourcePeerId!==m.sourcePeerId),
  calendarMessageDateKey:m=>getLocalDateString(new Date(m.createdAt*1000),'Europe/Moscow'),
  calendarSummarySliceForTimestamp,calendarSummarySliceIsClosed,botTimeZone:'Europe/Moscow',
  saveHierarchyMessageState:s=>inserted.push(s),setImmediate
 };
 const fn=new Function(...Object.keys(defaults),app.slice(start,end)+'\nreturn collectUnpaidCalendarMessages;')(...Object.values(defaults));
 return {result:fn(2000000006,new Date('2026-11-09T00:00:00Z')),inserted};
}
const sept=1787471574,nov=1794160804,peer=2000000006;
const key=peer+':208919';
const paid={messageKey:key,contentHash:'hash-september',sourcePeerId:peer,conversationMessageId:208919,createdAt:sept,nodeKey:'legacy-paid-sept'};
const oldMsg={key,hash:'hash-september',sourcePeerId:peer,conversationMessageId:208919,createdAt:sept,text:'Сентябрь'};
const newMsg={key,hash:'hash-november',sourcePeerId:peer,conversationMessageId:208919,createdAt:nov,text:'Новое сообщение'};

test('same CMID two months apart is not considered paid even though legacy key exists',()=>{
 const rekey=resolveHierarchyMessageStateKey(key,nov,newMsg.hash,paid);
 assert.notEqual(rekey,key);
 assert.equal(rekey,'2000000006:208919:reused:1794160804');
 const {result}=scanner([oldMsg,newMsg],[paid]);
 const found=[...result.groups.values()].flatMap(g=>g.messages);
 assert.equal(found.length,1);
 assert.equal(found[0].createdAt,nov);
 assert.equal(found[0].hierarchyStateKey,rekey);
 assert.equal(result.paidCount,1);
 assert.equal(result.reusedUnpaid,1);
});

test('after the collision version has been saved, the same message is never paid twice',()=>{
 const version=resolveHierarchyMessageStateKey(key,nov,newMsg.hash,paid);
 const saved={...paid,messageKey:version,contentHash:newMsg.hash,createdAt:nov,nodeKey:'new-paid-nov'};
 const {result}=scanner([oldMsg,newMsg],[paid,saved]);
 assert.equal(result.groups.size,0);
 assert.equal(result.paidCount,2);
 assert.equal(result.reusedUnpaid,0);
});
test('ordinary message edits and recovery within five minutes do not re-trigger AI payment',()=>{
 assert.equal(resolveHierarchyMessageStateKey(key,sept,'edited',{...paid}),key);
 assert.equal(resolveHierarchyMessageStateKey(key,sept+15,'different',{...paid}),key);
 assert.equal(resolveHierarchyMessageStateKey(key,nov,'identical',{...paid,contentHash:'identical'}),key);
});
test('different source peers never collide even if their native CMIDs are identical',()=>{
 const paidMsg={...oldMsg,key:'2000000002:208919',sourcePeerId:2000000002};
 const oldState={...paid,messageKey:'2000000002:208919',sourcePeerId:2000000002};
 const {result}=scanner([paidMsg,newMsg],[oldState]);
 const found=[...result.groups.values()].flatMap(g=>g.messages);
 assert.equal(found.length,1);
 assert.equal(found[0].key,key);
 assert.equal(found[0].hierarchyStateKey,undefined);
});
test('hierarchical tree and calendar both use versioned coverage keys and never overwrite paid rows',()=>{
 assert.match(app,/function hierarchyMessageKey\(message, canonicalPeerId\) \{\s*if \(message\?\.hierarchyStateKey\)/u);
 assert.match(app,/const pending = history\.flatMap\(/u);
 assert.match(app,/resolveHierarchyMessageStateKey\(/u);
 assert.match(app,/group\.messages\.push\(messageKey === legacyKey \? message : \{ \.\.\.message, hierarchyStateKey: messageKey \}\)/u);
 const store=readFileSync(new URL('../../src/infrastructure/database/hierarchicalSummaryStateStore.js',import.meta.url),'utf8');
 assert.match(store,/ON CONFLICT\(message_key\) DO NOTHING/u);
});

test('an edit after a collision has been stored does not create a second paid revision',()=>{
 const keyOnce=resolveHierarchyMessageStateKey(key,nov,'hash-november',paid);
 const afterEdit=resolveHierarchyMessageStateKey(key,nov,'edited-text-content-hash',paid);
 assert.equal(keyOnce,afterEdit);
 const saved={...paid,messageKey:keyOnce,contentHash:'hash-november',createdAt:nov};
 const {result}=scanner([{...newMsg,hash:'edited-text-content-hash'}],[paid,saved]);
 assert.equal(result.groups.size,0);
});
