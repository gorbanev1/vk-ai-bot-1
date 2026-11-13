import test from 'node:test';
import assert from 'node:assert/strict';
import {parseChatFunctionToggle,chatFunctionsStateKey,normalizeChatFunctionsState,partyDisabledResponse,autoSummaryCommandExamples} from '../../src/features/routing/chatFunctionToggles.js';
test('parties toggle exact on/off synonyms and optional bot address',()=>{
 for(const [s,action] of [['тусы выкл','disable'],['тусы выключить','disable'],['Тусы включить','enable'],['тусы вкл','enable'],['Гигорейв, тусы выкл','disable'],['Гигорейв тусы включить','enable'],['тусовки выкл','disable'],['выключить тусы','disable'],['включить тусы','enable'],['Тусы выключ','disable']]){
  assert.deepEqual(parseChatFunctionToggle(s),{kind:'parties',action},s);
 }
 for(const s of ['тусы сегодня','тусы на месяц','тусы повторы карточки 6 часов','где кураж выкл','статистика за неделю'])assert.equal(parseChatFunctionToggle(s),null,s);
});
test('message and reaction statistics toggle as one feature',()=>{
 for(const [s,action] of [['статистика выкл','disable'],['статистика выключить','disable'],['статистика вкл','enable'],['статистика включить','enable'],['статы вкл','enable'],['статистика сообщений выкл','disable'],['статистика реакций вкл','enable'],['статистика лайков выключить','disable'],['выключить статистику','disable'],['включить статистику сообщений','enable']]){
  assert.deepEqual(parseChatFunctionToggle(s),{kind:'statistics',action},s);
 }
});
test('per-chat state uses a durable platform/chat key and preserves independent switches',()=>{
 assert.notEqual(chatFunctionsStateKey('vk',2000000006),chatFunctionsStateKey('vk',2000000010));
 assert.notEqual(chatFunctionsStateKey('vk',2000000010),chatFunctionsStateKey('telegram',2000000010));
 assert.deepEqual(normalizeChatFunctionsState(),{partiesEnabled:true,statisticsEnabled:true});
 assert.deepEqual(normalizeChatFunctionsState({partiesEnabled:false}),{partiesEnabled:false,statisticsEnabled:true});
 assert.match(partyDisabledResponse,/тусы вкл/u);
});
test('owner receives complete auto-summary examples with saved schedule on enable',()=>{
 assert.match(autoSummaryCommandExamples,/авторезюме 12:00 дневное/u);
 assert.match(autoSummaryCommandExamples,/авторезюме 12:00 13:00 15:00 18:00 дневное недельное/u);
 assert.match(autoSummaryCommandExamples,/недельное 20:00 месячное 18:00 среднее/u);
 assert.match(autoSummaryCommandExamples,/последнее сохранённое расписание/u);
});
