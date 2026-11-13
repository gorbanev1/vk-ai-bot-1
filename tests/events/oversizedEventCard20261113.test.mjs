import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {configureEventAnnouncementCopies,prepareEventAnnouncementCopies,selectEventAnnouncement,renderBudgetedEventCard,eventCardModelLengthContract,extractSourceBoundedAnnouncement} from '../../src/features/events/eventAnnouncementCopies.js';
import {PARSER_ALLOWED_MODELS,restrictParserModelLadder,GPT_MODEL_LADDER,POSTER_VISION_MODEL_LADDER} from '../../src/features/ai/parserModelLadder.js';
function fixture(options={}) {
 const saved=new Map();
 configureEventAnnouncementCopies({render:(e,p,t)=>(e.header||'Header\n')+t,load:k=>saved.get(k),save:(k,v)=>saved.set(k,v),...options});
 return saved;
}
test('fitting original is preserved exactly without an editor call',async()=>{
 let edits=0;fixture({edit:async()=>{edits++;throw Error('unnecessary')}});
 const original='Все факты, & символы < > 🎸.\n\nПоследний абзац.';
 const [e]=await prepareEventAnnouncementCopies([{description:original}],{ensureSummaries:false});
 assert.equal(selectEventAnnouncement(e,'telegram'),original); assert.equal(edits,0);
});
test('oversized result is retried with concrete length feedback; only model copy is delivered',async()=>{
 const inputs=[]; fixture({edit:async input=>{inputs.push(input);return {shared:input.attempt===1?'X'.repeat(1200):'Модель связно сократила анонс.'}}});
 const original='Полный исходник. '.repeat(180);
 const [e]=await prepareEventAnnouncementCopies([{description:original}],{ensureSummaries:false});
 assert.equal(inputs.length,2); assert.match(inputs[1].previousError,/1200/);
 assert.equal(selectEventAnnouncement(e,'telegram'),'Модель связно сократила анонс.');
 assert.equal(e.description,original.trim());
});
test('two oversized AI answers never leak an error: extractive source fallback keeps another card safe',async()=>{
 let calls=0;fixture({edit:async()=>{calls++;return{shared:'X'.repeat(5000)}}});
 const original='Воронежский концерт промышленной электроники. Участвуют пять музыкантов. Билеты доступны на входе.\n'.repeat(50);
 const events=[{description:original,header:'🎸 Концерт\n📅 22 ноября\n📍 Рок-бар\nИсточник: https://vk.ru/post\n'},{description:'Short source.'}];
 const result=await prepareEventAnnouncementCopies(events,{ensureSummaries:false});
 assert.equal(calls,2);
 assert.equal(result[0].announcementPreparationError,undefined);
 const prepared=selectEventAnnouncement(result[0],'telegram');
 assert.ok(prepared.includes('концерт')||prepared.includes('электроники'));
 assert(!prepared.includes('XXXXX'));
 assert.equal(result[0].description,original.trim());
 assert.ok(renderBudgetedEventCard(result[0],'telegram',prepared,result[0].header+prepared).length<=1000);
 assert.equal(selectEventAnnouncement(result[1],'telegram'),'Short source.');
});
test('1073 header is shortened by a model before budgeting the unchanged original',async()=>{
 let metadataCalls=0;fixture({editMetadata:async input=>{metadataCalls++;assert.equal(input.platform,'telegram');return {template:'Событие · 20 ноября · Diesel\n{{ANNOUNCEMENT}}'}}});
 const e={header:'H'.repeat(1073),description:'Сохранить оригинал полностью.'};
 const [prepared]=await prepareEventAnnouncementCopies([e],{ensureSummaries:false});
 assert.equal(metadataCalls,1);
 const body=selectEventAnnouncement(prepared,'telegram');assert.equal(body,e.description);
 const card=renderBudgetedEventCard(prepared,'telegram',body,e.header+body);
 assert.ok(card.length<=1000);assert.ok(card.endsWith(e.description));
});
test('invalid metadata cannot remove source provenance or pass the complete-card guard',async()=>{
 fixture({editMetadata:async()=>({template:'No source {{ANNOUNCEMENT}}'})});
 const e={sourceUrl:'https://vk.ru/wall-1_2',header:'H'.repeat(1073)+'https://vk.ru/wall-1_2\n',description:'Original.'};
 const [p]=await prepareEventAnnouncementCopies([e],{ensureSummaries:false});
 assert.ok(p.announcementPreparationError);
 assert.throws(()=>renderBudgetedEventCard(p,'telegram','Original.',e.header+'Original.'),{code:'EVENT_CARD_PREPARATION_PENDING'});
});
test('only five parser models survive a stale profile, in required order, with original attempt counts',()=>{
 const expected=['gpt-6-luna','gpt-5.6-luna','gpt-5.6-terra','gpt-6.1-sol','gpt-6-astra'];
 assert.deepEqual(PARSER_ALLOWED_MODELS,expected);
 for(const ladder of [GPT_MODEL_LADDER,POSTER_VISION_MODEL_LADDER])assert.deepEqual(ladder.map(x=>x.model),expected);
 const supplied=[...expected,'qwen','gpt-6-sol','gpt-5.6-sol','claude-opus-4-8'].reverse().map((model,i)=>({model,attempts:i+1}));
 const filtered=restrictParserModelLadder(supplied);
 assert.deepEqual(filtered.map(x=>x.model),expected);
 for(const step of filtered)assert.equal(step.attempts,supplied.find(x=>x.model===step.model).attempts);
 const app=fs.readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const fn=app.slice(app.indexOf('async function generateDefaultGptText('),app.indexOf('const VISION_IMAGE_MAX_COUNT'));
 assert.doesNotMatch(fn,/generateLocalQwenText/);
});

test('underfilled first response triggers one attempt for more facts; fuller valid version wins',async()=>{
 let calls=0,minimum=0;
 fixture({edit:async({budgets,attempt,previousError})=>{
  calls++;
  if(attempt===1)return {shared:'Model-written version.'};
  assert.match(previousError,/слишком короткий/);
  minimum=Math.floor(budgets.telegram*0.90);
  const prefix='Подробности события: ';
  return {shared:prefix+'А'.repeat(Math.floor(budgets.telegram*0.95)-prefix.length)};
 }});
 const [e]=await prepareEventAnnouncementCopies([{description:'Original sentence. '.repeat(200)}],{ensureSummaries:false});
 assert.equal(calls,2);
 assert(selectEventAnnouncement(e,'telegram').length>=minimum);
 assert(selectEventAnnouncement(e,'telegram').length<=1000);
});
test('if refinement fails, valid short first answer survives without fabrication',async()=>{
 let calls=0;fixture({edit:async({attempt})=>{calls++;if(attempt===2)throw Error('Provider temporary failure');return {shared:'Model-written version.'};}});
 const [e]=await prepareEventAnnouncementCopies([{description:'Original sentence. '.repeat(200)}],{ensureSummaries:false});
 assert.equal(calls,2);assert.equal(selectEventAnnouncement(e,'telegram'),'Model-written version.');
});

test('90–98 percent is an occupancy target, hard maximum remains exact on both tries',()=>{
 const first=eventCardModelLengthContract(772,1),second=eventCardModelLengthContract(772,2);
 const expected={hardMaxChars:772,modelMaxChars:772,targetMinChars:694,targetMaxChars:756};
 assert.deepEqual(first,expected);assert.deepEqual(second,expected);
 assert(first.targetMinChars<=first.targetMaxChars&&first.targetMaxChars<first.hardMaxChars);
});
test('one-character overflow is rejected, successful retry uses 95% of real budget',async()=>{
 let calls=0,hard=0;
 fixture({edit:async({budgets,attempt,previousError})=>{
  calls++;hard=budgets.telegram;
  if(attempt===1)return {shared:'Z'.repeat(hard+1)};
  assert.match(previousError,/превышение 1/);
  return {shared:'С'.repeat(Math.floor(hard*0.95))};
 }});
 const [e]=await prepareEventAnnouncementCopies([{description:'Фестиваль. '.repeat(600)}],{ensureSummaries:false});
 assert.equal(calls,2);
 assert.equal(selectEventAnnouncement(e,'telegram').length,Math.floor(hard*0.95));
 assert(selectEventAnnouncement(e,'telegram').length<=hard);
});
test('hard ceiling and near-full target are BOTH explicit in the model instruction',()=>{
 const app=fs.readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/ЦЕЛЕВОЙ ДИАПАЗОН:/);
 assert.match(app,/90–98% остатка/);
 assert.match(app,/НИКОГДА не превышай абсолютный потолок/);
 assert.doesNotMatch(app,/Не стремись заполнить 90–100%/);
 assert.doesNotMatch(app,/лимит ещё меньше/);
});
test('exact full-card budget includes pre-occupied header, source and actual markup',async()=>{
 const header='H'.repeat(228),limits=[];
 fixture({
  render:(e,p,body)=>header+body,
  markupExpansion:()=>27,
  telegramCaptionExpansion:()=>13,
  edit:async({budgets})=>{limits.push(budgets);return {shared:'Краткая и точная афиша с программой.'}}
 });
 const [e]=await prepareEventAnnouncementCopies([{description:'Афиша и программа. '.repeat(180)}],{ensureSummaries:false});
 assert.equal(limits.length,2); // The first response was safe but underfilled; a second attempt targets 90–98%.
 assert.equal(limits[0].telegram,759);
 assert.equal(limits[0].vk,759); // both platforms use the stricter shared Telegram limit
 assert.equal(selectEventAnnouncement(e,'telegram'),'Краткая и точная афиша с программой.');
 assert(228+selectEventAnnouncement(e,'telegram').length+13<=1000);
});
test('source-derived fallback never fabricates prices/dates and always fits',()=>{
 const src='Название: Источник\nДата: 22.11.2026\nОписание: Индустриальный концерт в рок-баре. Участвуют местные музыканты. Начало в 18:00. Вход бесплатный.';
 const out=extractSourceBoundedAnnouncement(src,76);
 assert(out.length<=76);
 assert(out.includes('Индустриальный'));
 assert(!out.includes('VIP')&&!out.includes('1500'));
});
test('Telegram caption always fits even if model returns 5000 characters twice',async()=>{
 fixture({render:(e,p,body)=>'🎸 INDUSTRIAL WEEKEND Part 2\n📅 22.11.2026\n🕒 18:00\n📍 The Last of Vavilone\nИсточник: https://vk.ru/wall-242992506_1\n\n'+body,
 edit:async()=>({shared:'X'.repeat(5000)})});
 const original='Описание: Сессия индустриальной музыки с несколькими выступлениями, поддержкой клуба и яркой программой.\nБесплатный вход.\n'.repeat(32);
 const [prepared]=await prepareEventAnnouncementCopies([{description:original,sourceUrl:'https://vk.ru/wall-242992506_1'}],{ensureSummaries:false});
 const body=selectEventAnnouncement(prepared,'telegram');
 const full='🎸 INDUSTRIAL WEEKEND Part 2\n📅 22.11.2026\n🕒 18:00\n📍 The Last of Vavilone\nИсточник: https://vk.ru/wall-242992506_1\n\n'+body;
 assert(full.length<=1000,full.length);
 assert.equal(prepared.description,original.trim());
 assert(!body.includes('XXXXX'));
});
