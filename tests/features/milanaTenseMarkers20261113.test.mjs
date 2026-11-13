import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMilanaTenseMarkerService,parseMilanaTenseMarkerCommand,MARKER_EXIT_BUTTON,MARKER_RESUME_BUTTON} from '../../src/features/education/milanaTenseMarkerService.js';
import {makeMarkerTheoryMessages,markerTheoryStats} from '../../src/features/education/milanaTenseMarkerContent.js';
import {MARKER_QUESTIONS,MARKER_QUESTION_COUNTS} from '../../src/features/education/milanaTenseMarkerQuestions.js';
import {buildTelegramMilanaMarkerMenu} from '../../src/platforms/telegram/telegramBot.js';

const root=()=>{const dir=mkdtempSync(join(tmpdir(),'gigorave-milana-marker-test-'));mkdirSync(join(dir,'data'),{recursive:true});writeFileSync(join(dir,'data','telegram-reminders.json'),JSON.stringify({helpNudges:[{id:'milana-test',chatId:'123456789'}]}));return dir};
const ctx=(from,input='')=>({platform:'telegram',isDM:true,telegramChatType:'private',externalPeerId:from,externalSenderId:from,originalText:input,text:input,conversationMessageId:8910,send:async()=>({message_id:999})});
const options={isOwner:true};
function setup(dir,handlers={}){
 const sent=[],clock=new Date('2026-11-13T11:00:00.000Z'),values=[];
 let id=400;
 const telegramApi={sendMessage:async payload=>{sent.push({...payload,message_id:++id});return {message_id:id}}};
 const service=createMilanaTenseMarkerService({root:dir,telegramApi,ownerChatId:'4444',
  clockNow:()=>clock,autoStartDay:'',gradeAnswer:async args=>{values.push(args);return handlers.gradeAnswer?.(args)||{percent:81,correct:'Смысл в целом передан',mistakes:'Есть неточности',advice:'Сверь форму с контекстом и точкой отсчёта.'}},
  buildKeyboard:mode=>buildTelegramMilanaMarkerMenu({mode,isOwner:false}),
 });
 return {service,sent,clock,grades:values,telegramApi};
}
test('all 12 tenses, two affirmative/negative/interrogative real examples and messages within Telegram 4096',()=>{
 const t=markerTheoryStats(),messages=makeMarkerTheoryMessages();
 assert.equal(t.tenseCount,12);assert.equal(t.exampleCount,72);
 assert.equal(messages.length,9);
 assert(messages.every(x=>x.length<=4096));
 assert(messages.some(x=>x.includes('Present Perfect')));
 assert(messages.some(x=>x.includes('Past Perfect Continuous')));
 assert(messages.some(x=>x.includes('Future Perfect Continuous')));
 assert(messages.some(x=>x.includes('МАРКЕРЫ-ЛОВУШКИ')));
});
test('question bank has 200+ unique scenario, voice, choice and Perfect contrast questions',()=>{
 assert.equal(MARKER_QUESTIONS.length,247);
 assert.equal(new Set(MARKER_QUESTIONS.map(x=>x.id)).size,247);
 assert(MARKER_QUESTION_COUNTS.perfect>=100);
 assert(MARKER_QUESTION_COUNTS.oral>=35);
 assert(MARKER_QUESTION_COUNTS.choices>=80);
 for(const q of MARKER_QUESTIONS){assert(q.id&&q.text&&q.expected);if(q.type==='choice'){assert(q.options.includes(q.correct));assert(q.options.length<=4)}}
});
test('all launch and private exit/resume commands recognized by aliases',()=>{
 for(const s of ['слова маркеры времен','слова маркеры времен милане','слова маркеры времен милана','милане слова маркеры времен','слова маркеры времен для миланы','/слова маркеры времен'])assert.equal(parseMilanaTenseMarkerCommand(s)?.action,'start',s);
 assert.equal(parseMilanaTenseMarkerCommand(MARKER_EXIT_BUTTON)?.action,'exit');
 assert.equal(parseMilanaTenseMarkerCommand(MARKER_RESUME_BUTTON)?.action,'resume');
 assert.equal(parseMilanaTenseMarkerCommand('слова маркеры времен статус')?.action,'status');
 assert.equal(parseMilanaTenseMarkerCommand('слова маркеры времен сброс')?.action,'reset');
 assert.equal(parseMilanaTenseMarkerCommand('расскажи что-то ещё'),null);
});
test('keyboard first row is one test-exit button with all original main menu rows after it; paused only resume',()=>{
 const normal=buildTelegramMilanaMarkerMenu({mode:'idle'});
 const active=buildTelegramMilanaMarkerMenu({mode:'active'});
 const paused=buildTelegramMilanaMarkerMenu({mode:'paused'});
 assert.deepEqual(active.keyboard[0],[{text:MARKER_EXIT_BUTTON}]);
 assert.deepEqual(paused.keyboard[0],[{text:MARKER_RESUME_BUTTON}]);
 assert.deepEqual(active.keyboard.slice(1),normal.keyboard);
 assert.deepEqual(paused.keyboard.slice(1),normal.keyboard);
 assert(active.keyboard.length>5);
});
test('full real service workflow: start by owner -> 9 theory -> inline choice -> honest Luna reply -> next question -> voice -> pause -> resume -> persistence',async()=>{
 const dir=root();
 try{
  const {service,sent,grades}=setup(dir);
  const owner=ctx('4444','слова маркеры времен милане');
  let ownerReplies=[];owner.send=async p=>{ownerReplies.push(p);return {message_id:123}};
  assert.equal(await service.handleMessage(owner,options),true);
  assert.equal(service.snapshot().recipientChatId,'123456789');
  assert.equal(service.snapshot().mode,'active');
  assert.equal(service.snapshot().theoryIndex,9);
  assert.equal(sent.length,10,'9 theory messages + first question');
  assert(sent.slice(0,9).every(x=>x.parseMode==='HTML'));
  assert(sent.some(x=>x.text.includes('Вопрос')||x.text.includes('вопрос')));
  assert.equal(sent.at(-1).replyMarkup.inline_keyboard.length,2);
  assert.equal(service.snapshot().active.id,'TM001');
  const wrongUser={...ctx('999999'),callbackQuery:{data:'tmq:TM001:1'},answerCallbackQuery:async()=>{}};
  await service.handleCallback(wrongUser);
  assert.equal(service.snapshot().grades.length,0,'other user cannot answer');
  const milana=ctx('123456789');
  const qMsg=sent.at(-1).message_id;
  const button={...milana,callbackQuery:{data:'tmq:TM001:1',message:{message_id:qMsg}},answerCallbackQuery:async()=>{}};
  assert.equal(await service.handleCallback(button),true);
  assert.equal(grades.length,1);
  assert.equal(service.snapshot().grades.length,1);
  assert.equal(service.snapshot().grades[0].percent,100,'exact correct choice deterministic');
  assert.equal(service.snapshot().active.id,'TM002','next question queued after grade');
  assert(sent.some(x=>x.text.includes('Луна')));
  const voice={...ctx('123456789'),originalText:'',text:'',voiceTranscript:'has not arrived',conversationMessageId:8511};
  assert.equal(await service.handleMessage(voice,{isOwner:false}),true);
  assert.equal(grades.length,2);
  assert.equal(grades[1].isVoiceTranscript,true);
  assert.equal(service.snapshot().grades.length,2);
  assert.equal(service.snapshot().grades[1].voice,true);
  const before=sent.length;
  assert.equal(await service.handleMessage(ctx('123456789',MARKER_EXIT_BUTTON),{isOwner:false}),true);
  assert.equal(service.snapshot().mode,'paused');
  assert(sent.length>before);
  assert.deepEqual(sent.at(-1).replyMarkup.keyboard[0],[{text:MARKER_RESUME_BUTTON}]);
  assert.equal(await service.handleMessage(ctx('123456789',MARKER_RESUME_BUTTON),{isOwner:false}),true);
  assert.equal(service.snapshot().mode,'active');
  service.stop();
  const {service:reloaded}=setup(dir);
  assert.equal(reloaded.snapshot().grades.length,2,'durable progress saved across restart');
  assert.equal(reloaded.snapshot().theoryIndex,9,'theory not resent after restart');
  assert.equal(reloaded.snapshot().mode,'active');
  reloaded.stop();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('test-mode does not respond to unrelated people or unrelated callback ids',async()=>{
 const dir=root();
 try{const {service,sent}=setup(dir);
  const stranger=ctx('999999','слова маркеры времен');
  assert.equal(await service.handleMessage(stranger,{isOwner:false}),false);
  assert.equal(service.snapshot().mode,'idle');
  assert.equal(sent.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
