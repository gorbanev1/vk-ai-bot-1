import test from 'node:test';import assert from 'node:assert/strict';
import {createPublicEventRangeService,restrictPublicEventsToFuture} from '../../src/features/events/publicEventRange.js';
import {parseQticketsCommand} from '../../src/features/events/qticketsRouting.js';
import {parsePartyPoolRequest} from '../../src/features/events/partyPool.js';
const service=createPublicEventRangeService({timeZone:'Europe/Moscow',now:()=>new Date('2026-10-31T08:00:00Z')});
const parse=s=>service.parsePublicEventsRangeCommand(s);
for(const [text,from,to] of [
 ['2027','2027-01-01','2027-12-31'],['2027 и 2027','2027-01-01','2027-12-31'],
 ['2026','2026-10-31','2026-12-31'],['2017-2027','2026-10-31','2027-12-31'],
 ['с 2017 до 2027','2026-10-31','2027-12-31'],
 ['30.10.2026 — 02.11.2026','2026-10-31','2026-11-02'],
 ['2026-10-30 — 2027-01-01','2026-10-31','2027-01-01'],
 ['30/10/26 по 02/11/26','2026-10-31','2026-11-02'],
 ['с 30 октября 2026 до 2 ноября 2026','2026-10-31','2026-11-02'],
 ['30–31 октября 2026','2026-10-31','2026-10-31'],
 ['30 октября по 2 ноября','2026-10-31','2026-11-02'],
 ['октябрь-ноябрь 2026','2026-10-31','2026-11-30'],
 ['ноябрь 2027','2027-11-01','2027-11-30'],
 ['31.10.26','2026-10-31','2026-10-31'],
 ['2027-01-02','2027-01-02','2027-01-02'],
 ['1 ноя 2026','2026-11-01','2026-11-01'],
 ['декабрь 2026 — январь 2027','2026-12-01','2027-01-31'],
]){
 test('calendar '+text,()=>{const r=parse('тусы '+text);assert.equal(r?.fromDate,from);assert.equal(r?.toDate,to);assert.ok(!r.pastOnly&&!r.invalid);});
 test('secondary and QTickets '+text,()=>{
   const secondary=parsePartyPoolRequest('второстепенные тусы '+text);
   const qr=parseQticketsCommand('кутикетс тусы '+text);
   assert.equal(qr.maxPrice,null);assert.equal(parse('тусы '+qr.rangeText)?.fromDate,from);
   assert.equal(parse(secondary.text)?.toDate,to);
 });
}
for(const text of ['2017','2017–2025','30.10.2026','январь 2026','прошедшие','прешедшие','вчера']){
 test('past-only '+text,()=>{const r=parse('тусы '+text);assert.equal(r?.pastOnly,true);assert.equal(r.notice,'Прошедшие тусы не показываю.');});
}
test('past and future returns only future with explanation',()=>{const r=parse('прошедшие и будущие тусы');assert.equal(r.fromDate,'2026-10-31');assert.match(r.notice,/только будущие/);assert.ok(!r.pastOnly);});
test('clamping is idempotent and retains ongoing ranges',()=>{const r=parse('тусы 2017–2027');assert.deepEqual(restrictPublicEventsToFuture(r,'2026-10-31'),r);assert.equal(r.requestedFromDate,'2017-01-01');});
test('classifier past date and month do not fall back to upcoming',()=>{for(const t of ['date=2026-10-30','month=2026-01'])assert.equal(service.publicEventsRangeFromClassifierToken(t).pastOnly,true);});
test('invalid dates do not silently select another month',()=>assert.equal(parse('тусы 31 февраля 2027').invalid,true));
test('QTickets price and calendar are independent',()=>{
 const c=parseQticketsCommand('qtickets тусы с 30.10.2026 до 02.11.2026 до 700');
 assert.equal(c.maxPrice,700);assert.equal(parse('тусы '+c.rangeText).toDate,'2026-11-02');
 const d=parseQticketsCommand('qtickets тусы с 30 октября до 2 ноября до 500');
 assert.equal(d.maxPrice,500);assert.equal(parse('тусы '+d.rangeText).fromDate,'2026-10-31');
});
