import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createExtendedRangeApprovalStore,endOfNextCalendarWeek,rangeNeedsOwnerApproval} from '../../src/features/events/extendedRangeApproval.js';
const time=Date.parse('2026-11-12T13:40:00Z');
test('range ending this or next week is free; ANY day after next Sunday requires approval',()=>{
 assert.equal(endOfNextCalendarWeek(time),'2026-11-22');
 for(const d of ['2026-11-12','2026-11-15','2026-11-16','2026-11-22']){
  assert.equal(rangeNeedsOwnerApproval({fromDate:'2026-11-12',toDate:d},time),false,d);
 }
 for(const d of ['2026-11-23','2026-11-30','2027-01-12']){
  assert.equal(rangeNeedsOwnerApproval({fromDate:'2026-11-12',toDate:d},time),true,d);
 }
 assert.equal(rangeNeedsOwnerApproval({kind:'all'},time),true);
 assert.equal(endOfNextCalendarWeek(Date.parse('2026-11-15T23:00:00+03:00')),'2026-11-22');
 assert.equal(endOfNextCalendarWeek(Date.parse('2026-11-16T00:01:00+03:00')),'2026-11-29');
});
test('one persistent pending request wins exactly one cross-platform owner approval',()=>{
 const root=mkdtempSync(join(tmpdir(),'extended-party-approval-'));
 let now=time;
 const dbPath=join(root,'approval.sqlite');
 const payload={platform:'vk',peerId:'2000000011',requesterId:'494464822',
  routeMethod:'test-events',range:{fromDate:'2026-11-12',toDate:'2026-12-01'},
  allParties:false,options:{compact:false,partyPool:'primary'}};
 try{
  const store=createExtendedRangeApprovalStore({databasePath:dbPath,now:()=>now});
  const one=store.request(payload);
  assert.equal(one.created,true);
  assert.equal(store.request(payload).record.id,one.record.id);
  assert.equal(store.request(payload).created,false);
  assert.equal(one.record.status,'pending');
  assert.equal(store.decide(one.record.id,'approve','telegram').ok,true);
  assert.equal(store.decide(one.record.id,'approve','vk').ok,false);
  assert.equal(store.decide(one.record.id,'deny','vk').ok,false);
  assert.equal(store.finish(one.record.id,'delivered'),true);
  assert.equal(store.finish(one.record.id,'delivered'),false);
  assert.equal(store.get(one.record.id).decidedChannel,'telegram');
  const denied=store.request({...payload,range:{...payload.range,toDate:'2026-12-02'}});
  assert.equal(store.decide(denied.record.id,'deny','vk').status,'denied');
  assert.equal(store.decide(denied.record.id,'approve','telegram').ok,false);
  store.close();
  const reloaded=createExtendedRangeApprovalStore({databasePath:dbPath,now:()=>now});
  assert.equal(reloaded.get(one.record.id).status,'delivered');
  assert.equal(reloaded.get(denied.record.id).status,'denied');
  reloaded.close();
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('expired approvals fail closed and cannot authorize any delayed release',()=>{
 const root=mkdtempSync(join(tmpdir(),'expired-approval-'));
 let now=time;
 try{
  const store=createExtendedRangeApprovalStore({
   databasePath:join(root,'approval.sqlite'),now:()=>now,ttlMs:60000});
  const record=store.request({platform:'vk',peerId:'2000000006',requesterId:'44',
   range:{fromDate:'2026-11-12',toDate:'2026-12-03'},options:{},allParties:true}).record;
  now+=60001;
  assert.equal(store.decide(record.id,'approve','telegram').ok,false);
  assert.equal(store.decide(record.id,'approve','telegram').reason,'expired');
  assert.equal(store.get(record.id).status,'pending');
  store.close();
 }finally{rmSync(root,{recursive:true,force:true})}
});
