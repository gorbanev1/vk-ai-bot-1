import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAllPartiesRequest, resolveAllPartiesRange, includeQticketsInAllPartyRequest } from '../../src/features/events/allPartyDedupe.js';
import { resolveCommandPriority, resolveCommandPriorityCandidates } from '../../src/features/routing/commandPriorityRouting.js';
import { createPublicEventRangeService } from '../../src/features/events/publicEventRange.js';
import { parseEventSearchRequest } from '../../src/features/events/eventSearchTaxonomy.js';

const service=createPublicEventRangeService({timeZone:'Europe/Moscow',now:()=>new Date('2026-11-07T17:10:00Z')});
const dependencies={parseRange:service.parsePublicEventsRangeCommand,createByKind:service.createPublicEventsRangeByKind};
function parse(input){
 const route=resolveCommandPriority(input,{parsePublicEventsRangeCommand:service.parsePublicEventsRangeCommand,looksLikePublicEventsQuestion:service.looksLikePublicEventsQuestion});
 assert.equal(route.route,'all-parties','Routing: '+input);
 const command=route.selected.command;
 assert.ok(command.matched,input);
 return {command,range:resolveAllPartiesRange(command,dependencies)};
}
test('«где кураж» is a complete command irrespective of word order and bot address',()=>{
 const options=[
 'где кураж','Где Кураж?','Гигорейв, где кураж',
 'на этих выходных где кураж','Гигорейв, на этих выходных где кураж?',
 'Гигорейв где кураж на этих выходных','где на этих выходных кураж',
 'кураж где на этих выходных','Гигорейв, покажи где кураж на этих выходных',
 'Гигорейв, кураж где на этих выходных','Гигорейв, где будет кураж на этих выходных',
 'где кураж на этих выходных','Где Кураж на выходных','где кураж в эти выходные',
 ];
 for(const input of options){
  const {range}=parse(input);
  if(/выходн/iu.test(input))assert.deepEqual([range?.fromDate,range?.toDate],['2026-11-07','2026-11-08'],input);
  else assert.equal(range?.kind,'all',input);
 }
 for(const input of ['тусы сегодня','второстепенные тусы на месяц','Город Куража сегодня','где куражист','куражный где','привет, как дела']){
  assert.equal(parseAllPartiesRequest(input).matched,false,input);
 }
 const direct=resolveCommandPriority('тусы сегодня',{parsePublicEventsRangeCommand:service.parsePublicEventsRangeCommand});
 assert.equal(direct.route,'public-events-direct');
});
test('weekdays, named dates, ranges and natural alternative orders resolve correctly',()=>{
 for(const [input,kind,from,to] of [
  ['Гигорейв где кураж сегодня','today','2026-11-07','2026-11-07'],
  ['завтра где кураж','tomorrow','2026-11-08','2026-11-08'],
  ['в эту субботу где кураж','weekday','2026-11-07','2026-11-07'],
  ['где кураж 14 ноября','date','2026-11-14','2026-11-14'],
  ['14.11.2026 где кураж','date','2026-11-14','2026-11-14'],
  ['на этой неделе где кураж','week','2026-11-07','2026-11-08'],
  ['где кураж на следующей неделе','date-range','2026-11-09','2026-11-15'],
  ['где кураж на следующих выходных','date-range','2026-11-13','2026-11-15'],
  ['Гигорейв, на следующих выходных где кураж?','date-range','2026-11-13','2026-11-15'],
  ['на месяц где кураж','next30','2026-11-07','2026-12-06'],
  ['где кураж до конца месяца','currentMonth','2026-11-07','2026-11-30'],
  ['где кураж на 2 недели','nextDays','2026-11-07','2026-11-20'],
  ['на 3 недели где кураж','nextDays','2026-11-07','2026-11-27'],
  ['где кураж на семь дней','nextDays','2026-11-07','2026-11-13'],
  ['где кураж с 13 по 15 января','date-range','2027-01-13','2027-01-15'],
  ['с 13 по 15 января где кураж','date-range','2027-01-13','2027-01-15'],
  ['где кураж в декабре','month','2026-12-01','2026-12-31'],
 ]){
  const {range}=parse(input);
  assert.equal(range?.kind,kind,input);
  assert.deepEqual([range.fromDate,range.toDate],[from,to],input);
 }
});
test('«где кураж» filters and short mode preserve the primary/secondary aggregate',()=>{
 for(const input of ['где кураж на месяц diesel hall','на месяц diesel hall где кураж','где кураж на месяц кратко']){
  const {command,range}=parse(input);
  assert.equal(range?.kind,'next30',input);
  const search=parseEventSearchRequest(command.commandText.replace(/^где\s+кураж/iu,'тусы'));
  if(/diesel/i.test(input)){assert.ok(search?.venueKeys?.length,input);}
  if(/кратко/iu.test(input))assert.match(command.commandText,/кратко/u);
 }
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/selectPool\(PARTY_POOL_PRIMARY\)/u);
 assert.match(app,/selectPool\(PARTY_POOL_SECONDARY\)/u);
 assert.match(app,/getQticketsUpcomingEvents\(/u);
 assert.match(app,/dedupeAllPartiesRealtime\(candidates, metadataByKey\)/u);
 assert.match(app,/resolveAllPartiesRange\(command/u);
});
test('routing still supports bot prefix and unaddressed command in VK and Telegram',()=>{
 for(const input of ['где кураж сегодня','Гигорейв, где кураж сегодня','на этих выходных где кураж','Гигорейв, на этих выходных где кураж']){
  assert.equal(resolveCommandPriorityCandidates([input],{parsePublicEventsRangeCommand:service.parsePublicEventsRangeCommand}).route,'all-parties',input);
 }
});

test('«Где кураж» selects ONLY primary and secondary sources, NEVER QTickets',()=>{
 for(const input of [
  'где кураж', 'Гигорейв, где кураж на месяц',
  'на этих выходных где кураж', 'где на этих выходных кураж',
  'Гигорейв, покажи где кураж на месяц',
 ]){
  const parsed=parseAllPartiesRequest(input);
  assert.equal(parsed.matched,true,input);
  assert.equal(includeQticketsInAllPartyRequest(parsed),false,input);
 }
 for(const input of ['вообще все тусы на месяц','общие тусы','все вообще тусы']){
  const parsed=parseAllPartiesRequest(input);
  assert.equal(parsed.matched,true,input);
  assert.equal(includeQticketsInAllPartyRequest(parsed),true,input);
 }
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/if \(!includeQtickets\) return \[\.\.\.primary, \.\.\.secondary\]/u,'must skip querying QTickets entirely');
 assert.match(app,/includeQtickets:\s*includeQticketsInAllPartyRequest\(command\)/u,'route forwards source policy');
 assert.match(app,/includeQtickets \? selectedCandidates : selectedCandidates\.filter/u,'dedicated source defense');
 assert.ok(!app.includes('объединённая афиша основных, второстепенных и QTickets'));
});
