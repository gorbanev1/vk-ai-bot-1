import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { titleIdentityTokens, identityTokens } from '../../src/features/events/eventIdentityTokens.js';
import { compareEventsDeterministic, normalizeWholeEventTitle } from '../../src/features/events/eventDuplicateResolution.js';
import { cleanOriginalEventAnnouncement } from '../../src/features/events/eventAnnouncementCopies.js';
import { buildEventCardLinkMarkup } from '../../src/features/events/eventCardLinks.js';
const a={title:'От А до Я',eventDate:'2026-11-03',eventTime:'20:00',venue:'Liverpool Pub, ул. Куколкина, 33А/2',description:'ОТ А ДО Я 3 НОЯБРЯ 20:00'};
test('full title recovers names consisting entirely of short/function words',()=>{
 const b={...a,title:'«ОТ А ДО Я»',description:'3 ноября на сцене наш домашний коллектив',price:'Вход свободный'};
 assert.equal(compareEventsDeterministic(a,b).verdict,'same');
 assert.ok(compareEventsDeterministic(a,b).reasons.includes('whole-title-date-venue-time'));
 for(const change of [{title:'От А до Б'},{eventDate:'2026-11-04'},{venue:'Клуб 12'},{eventTime:'23:00'},{venue:''}]){
  assert.notEqual(compareEventsDeterministic(a,{...b,...change}).verdict,'same',JSON.stringify(change));
 }
});
test('standalone numbers of any length are title tokens, styled digits stay inside names',()=>{
 assert.deepEqual(titleIdentityTokens('Мой 2007-ой'),['2007']);
 assert.deepEqual(titleIdentityTokens('1 12 2007'),['1','12','2007']);
 assert.deepEqual(titleIdentityTokens('U2 7раса L1NK1N 2007'),['u2','7раса','l1nk1n','2007']);
 assert.ok(!titleIdentityTokens('7раса').includes('7'));
 assert.deepEqual(identityTokens('2007'),[]); // dates in free-text matching keep their existing policy
 assert.equal(normalizeWholeEventTitle('«Мой 2007-ой»'),'мой 2007');
 const b={...a,title:'Мой 2007-ой',eventDate:'2026-10-31',eventTime:'19:00',venue:'Клуб «12», ул. Космонавта Комарова, 1А'};
 assert.equal(compareEventsDeterministic(b,{...b,description:'Halloween в стиле Мой 2007-ой'}).verdict,'same');
 assert.notEqual(compareEventsDeterministic(b,{...b,title:'Мой 2008-ой'}).verdict,'same');
});
test('Vision protocol fields are not displayed as an announcement; ordinary labeled source stays intact',()=>{
 const raw='31 октября\nВремя: 19:00\nНачало:\nОкончание:\nМесто: клуб 12\nТеги: ["rock"]\nРаспознанный текст: HALLOWEEN; МОЙ 2007-ОЙ;';
 assert.equal(cleanOriginalEventAnnouncement(raw),'31 октября\nHALLOWEEN; МОЙ 2007-ОЙ;');
 const announcement='Время: 19:00\nМесто: Liverpool\nГород: Воронеж\nЦена: бесплатно\nПриходите!';
 assert.equal(cleanOriginalEventAnnouncement(announcement),announcement);
});
test('Telegram source link is present before announcement and survives caption shortening',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const body=app.slice(app.indexOf('export function buildSinglePublicEventMessage('),app.indexOf('\nfunction buildLinkedEventCardMessage('));
 const render=runInNewContext(body.replace('export ','')+'\nbuildSinglePublicEventMessage',{
  cleanEventTitle:v=>v,stripKnownVenueNamesFromEventTitle:v=>v,cleanVkEventText:v=>v,
  sharedEventDateLabel:()=>'',formatIsoEventDate:v=>v,getSharedEventSchedule:()=>null,
  buildPublicEventSourceBlock:e=>'Источник:\n'+e.sourceUrl, selectEventAnnouncement:e=>e.description,
  getDisplayEventVenue:e=>e.venue,isUsefulEventTicketUrl:()=>false
 });
 const event={...a,sourceUrl:'https://vk.ru/wall-95062430_2752',description:'Длинный исходный анонс. '.repeat(100)};
 const message=render(event,'telegram');
 assert.ok(message.indexOf(event.sourceUrl)<message.indexOf('📝 Анонс:'));
 const card=buildEventCardLinkMarkup(message,{event,platform:'telegram'});
 assert.ok(card.htmlCaption.includes(event.sourceUrl));
 assert.ok(card.text.includes(event.sourceUrl));
});

test('full-title fallback uses matching stored start time when original post writes time with a dot',async()=>{
 const {deduplicateEventsTwoContour}=await import('../../src/features/events/eventDuplicateResolution.js');
 const left={...a,sourceText:'От А до Я 3 ноября, 20.00',id:1};
 const right={...left,id:2,description:'Новый сезон, вход свободный'};
 assert.equal(compareEventsDeterministic(left,right).verdict,'same');
 const result=await deduplicateEventsTwoContour([left,right]);
 assert.equal(result.events.length,1);
});
