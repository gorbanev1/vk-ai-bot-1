import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { sendVkDmFirstWelcomeOnce, VK_DM_FIRST_WELCOME } from '../../src/features/routing/vkDmFirstWelcome.js';
import { formatTopicHelp, getTopicHelpDirectoryLines, parseTopicHelp } from '../../src/features/routing/topicHelpRouting.js';
import { createPublicEventRangeService } from '../../src/features/events/publicEventRange.js';

function fixture(){
 const seen=new Set(),messages=[];
 return {
  messages,
  consume({userId}){if(seen.has(userId))return {shouldSend:false};seen.add(userId);return {shouldSend:true}},
  send:async text=>{messages.push(text)}
 };
}
test('first VK private message sends AI introduction, party commands and complete-help pointer exactly once',async()=>{
 const f=fixture();
 const args={isPrivate:true,userId:456,consume:f.consume,send:f.send};
 assert.equal(await sendVkDmFirstWelcomeOnce(args),true);
 assert.equal(await sendVkDmFirstWelcomeOnce(args),false);
 assert.equal(f.messages.length,1);
 assert.match(f.messages[0],/ИИ-бот/);
 for(const token of ['тусы','ближайшие тусы','тусы второстепенные','вообще все тусы','помощь','запомни'])
  assert.ok(f.messages[0].includes('«'+token+'»'),token);
 assert.doesNotMatch(f.messages[0],/Пересоздан|22 августа|координаты откроются/iu);
});
test('no VK onboarding for group, outgoing or invalid sender, no state consumed',async()=>{
 const f=fixture();
 for(const extra of [{isPrivate:false,userId:99},{isPrivate:true,isOutbox:true,userId:99},{isPrivate:true,userId:0}]){
  assert.equal(await sendVkDmFirstWelcomeOnce({...extra,consume:f.consume,send:f.send}),false);
 }
 assert.equal(f.messages.length,0);
 assert.equal(await sendVkDmFirstWelcomeOnce({isPrivate:true,userId:99,consume:f.consume,send:f.send}),true);
 assert.equal(f.messages.length,1);
});
test('separate users each get a single first-contact notice',async()=>{
 const f=fixture();for(const id of [111,222,333,111,222])
 await sendVkDmFirstWelcomeOnce({isPrivate:true,userId:id,consume:f.consume,send:f.send});
 assert.equal(f.messages.length,3);
});
test('live VK routing no longer calls static Peresozdanie FAQ; first contact precedes early returns',()=>{
 const source=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.equal(source.includes('maybeHandleOrganizerPartyIncoming('),false);
 assert.equal(source.includes('getDmPartyFaqAnswers('),false);
 assert.equal(source.includes('classifyExplicitDmPartyRequest(requestText)'),false);
 const branch=source.indexOf("let directText = String(context.text ?? '').trim();");
 const send=source.indexOf('await sendVkDmFirstWelcomeOnce(',branch);
 const early=source.indexOf('if (await maybeHandlePostEventFeedbackIncoming(context, text))',branch);
 const dmHint=source.indexOf('if (await maybeSendVkPartyDmHint(context, text))',branch);
 assert.ok(branch>0&&send>branch&&early>send&&dmHint>send);
});
test('topical help covers current lessons, event commands, books, parser without old August auto-promo',()=>{
 assert.equal(parseTopicHelp('тусы справка'),'parties');
 assert.equal(parseTopicHelp('хуинглиш помощь'),'huinglish');
 const p=formatTopicHelp('parties',{platform:'vk',isPrivate:true});
 const h=formatTopicHelp('huinglish',{platform:'vk',isPrivate:true});
 const c=formatTopicHelp('chtivo',{platform:'vk',isPrivate:true});
 const parser=formatTopicHelp('parsers',{platform:'vk',isPrivate:true,isOwner:true});
 for(const token of ['тусы','тусы второстепенные','вообще все тусы','тусы стоп']) assert.ok(p.includes(token),token);
 for(const token of ['хуинглиш далее','хуинглиш урок 1','хуинглиш статус'])assert.ok(h.includes(token),token);
 for(const token of ['чтиво список','чтиво новая глава'])assert.ok(c.includes(token),token);
 assert.ok(parser.includes('парсер все новые'));
 assert.ok(parser.includes('парсер все восстановить'));
 assert.doesNotMatch(h+p,/Уроков пока один|22 августа|тот же день до 18/iu);
 const directory=getTopicHelpDirectoryLines().join('\n');
 for(const token of ['тусы','хуинглиш','парсер','модели','статистика','досье','чтиво'])assert.ok(directory.includes(token));
});
test('one-time SQLite migration disables only three legacy party FAQ intents, not the owner broadcast',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const db=readFileSync(new URL('../../src/infrastructure/database/index.js',import.meta.url),'utf8');
 assert.ok(db.includes("const vkDmLegacyFaqDisabledKey = 'vk-dm-legacy-party-faq-disabled-v188'"));
 assert.ok(db.includes("UPDATE dm_faq_answers SET enabled=0"));
 assert.ok(db.includes("UPDATE dm_party_faq SET enabled=0"));
 assert.ok(app.includes('PERESOZDANIE_FEEDBACK_TEMPLATE'));
 assert.ok(app.includes('handleCoordsOverrideOwnerCommand'));
});

test('secondary and primary party selection commands resolve locally without semantic AI, no past-event fallback',()=>{
 const svc=createPublicEventRangeService({timeZone:'Europe/Moscow',now:()=>new Date('2026-11-03T10:00:00Z')});
 for(const text of ['тусы второстепенные','второстепенные тусы','тусы основные','основные тусы']){
  const result=svc.parsePublicEventsRangeCommand(text);
  assert.ok(result,text);
  assert.equal(result.kind,'next14',text);
  assert.ok(result.fromDate>='2026-11-03',text);
 }
 assert.equal(svc.parsePublicEventsRangeCommand('прошедшие тусы').pastOnly,true);
});
