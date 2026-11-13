import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEventSearchRequest,eventMatchesSearchFilters,selectEventsByBestVenueMatch} from '../../src/features/events/eventSearchTaxonomy.js';
import {matchEventVenueCatalog,extractEventVenueAfterIn} from '../../src/features/events/eventVenueRequestMatching.js';
import {buildVkEventCardKeyboard} from '../../src/features/events/eventCardLinks.js';
import {createPublicEventRangeService} from '../../src/features/events/publicEventRange.js';
const events=[
{venue:'Diesel Hall, ул. Генерала Лизюкова, 4',venueKey:'diesel-hall',title:'ВЕРНИ МНЕ МОЙ'},
{venue:'Diesel Bar, ул. Генерала Лизюкова, 4',venueKey:'diesel-bar',title:'El Mental'},
{venue:'Бар «Тупик», проспект Революции, 31А',venueKey:'tupik',title:'GET BASS'},
{venue:'Рок-бар The Last of Vavilone',venueKey:'vavilon',title:'Existenter'},
];
test('actual November 14 request only gets BOTH Diesel venues, never other bars',()=>{
 const query='туса в дизеле 14 ноября подробно',parsed=parseEventSearchRequest(query);
 assert.equal(parsed.matched,true);assert.equal(parsed.venueQuery,'дизеле');
 assert.deepEqual(parsed.venueKeys,['diesel']);assert.deepEqual(parsed.tags,[]);
 assert.deepEqual(events.filter(x=>eventMatchesSearchFilters(x,parsed)).map(x=>x.title),['ВЕРНИ МНЕ МОЙ','El Mental']);
 const range=createPublicEventRangeService({timeZone:'Europe/Moscow'}).parsePublicEventsRangeCommand(query);
 assert.equal(range.fromDate,'2026-11-14');
});
test('both Diesel locations for generic wording; one venue for specific Hall/Bar',()=>{
 for(const q of ['тусы в дизеле 14 ноября','туса в дизель 14 ноября','туса в дизиле 14 ноября','тусы дизель']){
  const f=parseEventSearchRequest(q);assert.deepEqual(f.venueKeys,['diesel'],q);
  assert.deepEqual(events.filter(x=>eventMatchesSearchFilters(x,f)).map(x=>x.title),['ВЕРНИ МНЕ МОЙ','El Mental']);
 }
 for(const q of ['туса в Diesel Hall 14 ноября','тусы в дизель холл 14 ноября','тусы в дизель холле 14 ноября']){
  const f=parseEventSearchRequest(q);assert.deepEqual(f.venueKeys,['diesel-hall'],q);
  assert.deepEqual(events.filter(x=>eventMatchesSearchFilters(x,f)).map(x=>x.title),['ВЕРНИ МНЕ МОЙ']);
 }
 for(const q of ['туса в Diesel Bar 14 ноября','туса в рок-баре дизель 14 ноября']){
  const f=parseEventSearchRequest(q);assert.deepEqual(f.venueKeys,['diesel-bar'],q);
  assert.deepEqual(f.tags,[],q+' should not inherit rock genre from venue');
  assert.deepEqual(events.filter(x=>eventMatchesSearchFilters(x,f)).map(x=>x.title),['El Mental']);
 }
});
test('events are matched by actual venue only, not description mentioning other venues',()=>{
 const x={venue:'Бар «Тупик»',title:'Перешли из Diesel Hall',description:'Раньше играли в Diesel Bar'};
 assert.equal(eventMatchesSearchFilters(x,{venueKeys:['diesel']}),false);
 assert.equal(eventMatchesSearchFilters(x,{venueKeys:['tupik']}),true);
});
test('Russian case forms and unknown venues are handled without showing everything',()=>{
 assert.deepEqual(parseEventSearchRequest('туса в маме анархии 14 ноября').venueKeys,['mama-anarhiya']);
 assert.deepEqual(parseEventSearchRequest('тусы в Тупике 14 ноября').venueKeys,['tupik']);
 const x=parseEventSearchRequest('туса в несуществующей площадке 14 ноября');
 assert.equal(x.matched,true);assert.ok(x.venueQuery);assert.deepEqual(x.venueKeys,[]);
 assert.deepEqual(selectEventsByBestVenueMatch(events,x.venueQuery),[]);
});
test('new unlisted venue is picked by largest actual-name token overlap',()=>{
 const items=[{venue:'Клуб Зелёная Планета, Московский проспект',title:'A'},{venue:'Театр Молодёжный, Советская',title:'B'}];
 assert.equal(extractEventVenueAfterIn('туса в Зеленая Планета 14 ноября'),'зеленая планета');
 assert.deepEqual(selectEventsByBestVenueMatch(items,'зеленая планета').map(x=>x.title),['A']);
 assert.deepEqual(selectEventsByBestVenueMatch([{venue:'Клуб Чёрный Рыцарь, ул. Мира',title:'C'},...items],'черном рыцаре').map(x=>x.title),['C']);
 assert.deepEqual(selectEventsByBestVenueMatch(items,'молодежный').map(x=>x.title),['B']);
 assert.deepEqual(selectEventsByBestVenueMatch(items,'другое место'),[]);
});
test('VK keyboard wire parameter is ASCII JSON; Russian address label decodes correctly',()=>{
 const raw=buildVkEventCardKeyboard({venue:'Diesel Hall, ул. Генерала Лизюкова, 4',sourceType:'vk_public',sourceName:'rb_diesel',eventDate:'2026-11-14',id:42});
 assert.match(raw,/^[\x00-\x7f]+$/u);
 const buttons=JSON.parse(raw).buttons.flat().map(x=>x.action.label);
 assert.ok(buttons.includes('📍 Адрес на Яндекс.Картах'),JSON.stringify(buttons));
 assert.ok(buttons.some(x=>x.includes('Источник')));
 assert.ok(buttons.some(x=>x.includes('Напомнить')));
});
test('production enforces venue filters for date and follow-up routes',()=>{
 const source=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(source,/filters\?\.venueQuery \? selectEventsByBestVenueMatch/u);
 assert.match(source,/filters:search\?\.matched\?search:null/u);
});
