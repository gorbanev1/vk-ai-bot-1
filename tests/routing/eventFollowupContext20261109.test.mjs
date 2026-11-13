import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isHelpCommand} from '../../src/shared/commands.js';
import {resolveCommandPriority} from '../../src/features/routing/commandPriorityRouting.js';
import {createEventFollowupStore,parseEventFollowup,eventHasConfirmedFreeEntry} from '../../src/features/routing/eventFollowupContext.js';
test('natural help commands always resolve as local help',()=>{
 for(const x of ['какие команды есть','Какие у тебя команды?','что умеешь','что ты вообще умеешь','расскажи что умеешь','покажи что умеешь','какие функции есть','что можешь делать']){
  assert.equal(isHelpCommand(x),true,x);
  assert.equal(resolveCommandPriority(x).route,'help',x);
 }
 for(const x of ['скажи какие команды есть у ириса','помоги мне с работой','а на выходных?','покажи только бесплатные','тусы ноября кратко']){
  assert.equal(isHelpCommand(x),false,x);
 }
});
test('event follow-up parser accepts only explicit period or free refinements',()=>{
 assert.equal(parseEventFollowup('а на выходных?').periodPhrase,'на выходных');
 assert.equal(parseEventFollowup('покажи какие будут в выходные').periodPhrase,'на выходных');
 assert.deepEqual(parseEventFollowup('покажи только бесплатные'),{periodPhrase:'',freeOnly:true});
 assert.deepEqual(parseEventFollowup('на выходных только бесплатные'),{periodPhrase:'на выходных',freeOnly:true});
 assert.equal(parseEventFollowup('а завтра').periodPhrase,'завтра');
 for(const x of ['покажи','какие команды есть','привет','статистика','тусы ноября кратко','а давай ругаться','покажи бесплатные машины']){
  assert.equal(parseEventFollowup(x),null,x);
 }
});
test('context is isolated per sender, chat and platform; it expires',()=>{
 let t=1000;
 const store=createEventFollowupStore({now:()=>t,ttlMs:60000});
 const alice={platform:'vk',peerId:2000000011,senderId:181824119};
 const other={...alice,senderId:425925302};
 const otherChat={...alice,peerId:2000000010};
 assert.equal(store.match(alice,'а на выходных?'),null);
 const range={kind:'month',fromDate:'2026-11-09',toDate:'2026-11-30',label:'ноябрь'};
 assert.equal(store.remember(alice,{range,compact:true,partyPool:'primary'}),true);
 assert.equal(store.match(alice,'а на выходных?').state.compact,true);
 assert.equal(store.match(other,'а на выходных?'),null);
 assert.equal(store.match(otherChat,'а на выходных?'),null);
 assert.equal(store.match({...alice,platform:'telegram'},'а на выходных?'),null);
 assert.equal(store.match(alice,'какие команды есть'),null);
 t+=60001;assert.equal(store.match(alice,'а на выходных?'),null);
});
test('free entry filter is conservative, no guessing from unknown price',()=>{
 for(const price of ['0','0 ₽','бесплатно','Вход свободный','free entry'])assert.equal(eventHasConfirmedFreeEntry({price}),true,price);
 for(const price of ['','уточняйте','500 ₽','от 0 ₽','бесплатно до 20:00 потом 300 ₽','донат'])assert.equal(eventHasConfirmedFreeEntry({price}),false,price);
 assert.equal(eventHasConfirmedFreeEntry({isFree:true}),true);
 assert.equal(eventHasConfirmedFreeEntry({isFree:true,price:'150 ₽'}),false);
});
test('production integration keeps all event sources and cooldown path intact',()=>{
 const s=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(s,/eventFollowups\.match\(context,routingCandidates\)/u);
 assert.match(s,/eventFollowups\.remember\(context,/u);
 assert.match(s,/sendPublicEventsForRange\(context,range,'event-followup'/u);
 assert.match(s,/sendAllPartiesForRange\(context,range,'event-followup-all'/u);
 assert.match(s,/filters\?\.freeOnly \|\| eventHasConfirmedFreeEntry/u);
 assert.match(s,/beginPartyDeliveryCooldown\(context, range, normalizedPool, filters, events, compact\)/u);
});
