import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMilanaEnglishTensesService,parseMilanaEnglishCommand} from '../../src/features/education/milanaEnglishTenses.js';
import {createMilanaPhysicsService,parseMilanaPhysicsCommand} from '../../src/features/education/milanaPhysics.js';

const project=new URL('../../Milana/english-tenses-bank.json',import.meta.url);
function createEnglishFixture(){
 const root=mkdtempSync(join(tmpdir(),'milana-english-test-'));
 mkdirSync(join(root,'Milana'),{recursive:true});mkdirSync(join(root,'data'),{recursive:true});
 copyFileSync(project,join(root,'Milana','english-tenses-bank.json'));
 writeFileSync(join(root,'data','telegram-reminders.json'),JSON.stringify({helpNudges:[{id:'milana',chatId:'8019356616'}]}));
 const sent=[],evaluations=[],sender='8019356616';let id=200;
 let now=new Date('2026-11-12T06:59:00Z'); // 09:59 Moscow
 const api={sendMessage:async a=>{sent.push(a);return {message_id:++id}}};
 const service=createMilanaEnglishTensesService({
  root,telegramApi:api,random:()=>0,clockNow:()=>now,
  gradeAnswer:async q=>{evaluations.push(q);return {percent:63,correct:'Грамматическая идея верна',mistakes:'Нет примера',advice:'Повтори отрицание'};},
  logger:{error:()=>{},warn:()=>{}}
 });
 const ctx=(text,replyId=0,voice='')=>({
  externalSenderId:sender,externalPeerId:sender,isDM:true,
  originalText:text,text,voiceTranscript:voice,conversationMessageId:++id,
  message:{reply_to_message:replyId?{message_id:replyId}:null},
  send:async text=>{sent.push({chatId:sender,text})}
 });
 const owner=(text)=>({
  externalSenderId:'777',externalPeerId:'777',isDM:true,
  text,originalText:text,send:async text=>sent.push({chatId:'777',text})
 });
 return {root,sent,api,service,ctx,owner,evaluations,setTime:value=>{now=new Date(value)},
  cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('bank has all 144 thematic, 45 system and 12 exam questions with distinct IDs',()=>{
 const bank=JSON.parse(readFileSync(project,'utf8'));
 assert.equal(bank.sections.length,12);
 assert.equal(bank.sections.reduce((n,t)=>n+t.questions.length,0),144);
 assert.equal(bank.general.length,45);
 assert.equal(bank.tickets.length,12);
 const all=[...bank.sections.flatMap(t=>t.questions),...bank.general,...bank.tickets];
 assert.equal(new Set(all.map(q=>q.id)).size,201);
 assert.match(bank.sections[0].questions[0].text,/Present Simple/u);
 assert.match(bank.sections[11].questions[11].text,/Future Perfect Continuous/u);
 assert.ok(all.every(q=>q.text?.length>20));
});
test('both teaching and question controls parse only correct target commands',()=>{
 assert.equal(parseMilanaEnglishCommand('английские времена обучение вкл').action,'on');
 assert.equal(parseMilanaEnglishCommand('английские времена обучение выключить').action,'off');
 assert.equal(parseMilanaEnglishCommand('английские времена обучение включено вкл').action,'on');
 assert.equal(parseMilanaEnglishCommand('английские времена обучение вопросы выкл').action,'questions-off');
 assert.equal(parseMilanaEnglishCommand('английские времена обучение вопросы вкл').action,'questions-on');
 assert.equal(parseMilanaEnglishCommand('милане английские времена обучение вкл').action,'on');
 assert.equal(parseMilanaEnglishCommand('Милане: английские времена обучение выкл').action,'off');
 assert.equal(parseMilanaEnglishCommand('милане, английские времена обучение вопросы вкл').action,'questions-on');
 assert.equal(parseMilanaEnglishCommand('Милане — английские времена обучение вопросы выкл').action,'questions-off');
 assert.equal(parseMilanaEnglishCommand('физика обучение вкл'),null);
 assert.equal(parseMilanaPhysicsCommand('Милане физика обучение вкл').action,'on');
 assert.equal(parseMilanaPhysicsCommand('милане: физика обучение выкл').action,'off');
 assert.equal(parseMilanaPhysicsCommand('милане, физика обучение вопросы вкл').action,'questions-on');
 assert.equal(parseMilanaPhysicsCommand('Милане — физика обучение вопросы выкл').action,'questions-off');
 assert.equal(parseMilanaPhysicsCommand('физика обучение вкл').action,'on');
 assert.equal(parseMilanaPhysicsCommand('физика обучение выкл').action,'off');
 assert.equal(parseMilanaPhysicsCommand('физика обучение вопросы вкл').action,'questions-on');
 assert.equal(parseMilanaPhysicsCommand('физика обучение вопросы выкл').action,'questions-off');
 assert.equal(parseMilanaPhysicsCommand('физика обучение выключить').action,'off');
});
test('owner may use Milane prefix, while another user cannot change lessons',async()=>{
 const f=createEnglishFixture();
 try{
  await f.service.handleMessage(f.owner('Милане английские времена обучение выкл'),{isOwner:true});
  assert.equal(f.service.snapshot().enabled,false);
  await f.service.handleMessage(f.owner('Милане: английские времена обучение вкл'),{isOwner:true});
  assert.equal(f.service.snapshot().enabled,true);
  await f.service.handleMessage(f.owner('Милане английские времена обучение вопросы выкл'),{isOwner:true});
  assert.equal(f.service.snapshot().questionsEnabled,false);
  await f.service.handleMessage(f.ctx('Милане английские времена обучение вопросы вкл'),{isOwner:false});
  assert.equal(f.service.snapshot().questionsEnabled,false);
 }finally{f.cleanup()}
});
test('enabled English begins inside 10:00-18:00 Moscow, one active question and 30 min repeat',async()=>{
 const f=createEnglishFixture();
 try{
  assert.equal(f.service.bankCount,201);
  await f.service.tick();
  assert.equal(f.sent.length,0,'no late night or early morning question');
  f.setTime('2026-11-12T07:00:00Z');
  await f.service.tick();
  assert.equal(f.sent.length,1);
  assert.ok(f.service.snapshot().active);
  assert.equal(f.service.snapshot().daily['2026-11-12'].target,10);
  const original=f.service.snapshot().active.messageIds[0];
  assert.ok(f.service.isActiveReply(f.ctx('',original)));
  f.setTime('2026-11-12T07:29:00Z');await f.service.tick();
  assert.equal(f.sent.length,1);
  f.setTime('2026-11-12T07:30:00Z');await f.service.tick();
  assert.equal(f.sent.length,2);
  assert.equal(f.service.snapshot().active.messageIds.length,2);
  assert.equal(f.service.snapshot().active.messageIds[0],original);
 }finally{f.cleanup()}
});
test('Luna grades English without theory, handles voice transcript, stores score, does not overlap questions',async()=>{
 const f=createEnglishFixture();
 try{
  f.setTime('2026-11-12T07:00:00Z');await f.service.tick();
  const first=f.service.snapshot().active.messageIds[0];
  const response=f.ctx('Неверно распознана часть слов',first,'Май нейм из...')
  assert.equal(await f.service.handleMessage(response),true);
  assert.equal(f.evaluations.length,1);
  assert.equal(f.evaluations[0].isVoiceTranscript,true);
  assert.equal(f.evaluations[0].answer,'Май нейм из...');
  assert.equal('theory' in f.evaluations[0],false);
  assert.equal(f.service.snapshot().grades.length,1);
  assert.equal(f.service.snapshot().grades[0].percent,63);
  assert.equal(f.service.snapshot().active,null,'minimum gap before next question');
  f.setTime('2026-11-12T07:24:00Z');await f.service.tick();
  assert.equal(f.service.snapshot().active,null);
  f.setTime('2026-11-12T07:25:00Z');await f.service.tick();
  assert.ok(f.service.snapshot().active);
  assert.equal(f.service.snapshot().daily['2026-11-12'].asked,2);
  assert.equal(f.sent.filter(x=>String(x.text||'').includes('❓')).length,2);
 }finally{f.cleanup()}
});
test('English off and on preserve pending question and no accidental duplicate after restart',async()=>{
 const f=createEnglishFixture();
 try{
  f.setTime('2026-11-12T07:00:00Z');await f.service.tick();
  const id=f.service.snapshot().active.id;
  await f.service.handleMessage(f.owner('английские времена обучение выключить'),{isOwner:true});
  f.setTime('2026-11-12T10:00:00Z');await f.service.tick();
  assert.equal(f.service.snapshot().active.id,id);
  const before=f.sent.length;
  await f.service.handleMessage(f.owner('английские времена обучение вкл'),{isOwner:true});
  assert.equal(f.service.snapshot().active.id,id);
  assert.ok(f.sent.length>=before);
  const second=createMilanaEnglishTensesService({root:f.root,telegramApi:f.api,random:()=>0,
   clockNow:()=>new Date('2026-11-12T10:00:00Z'),
   gradeAnswer:async()=>({percent:100}),logger:{error:()=>{},warn:()=>{}}});
  assert.equal(second.snapshot().active.id,id);
  assert.equal(second.snapshot().daily['2026-11-12'].asked,1);
 }finally{f.cleanup()}
});
test('Luna medium reasoning used for English and high reasoning stays physics',()=>{
 const code=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const english=code.slice(code.indexOf('const milanaEnglishTensesService='),code.indexOf('function patrolAddressedMessage('));
 assert.match(english,/modelLadder:\s*\[\{model:GPT6_LUNA_MODEL_ID,mode:'default',reasoningEffort:'medium'/u);
 assert.match(english,/tokenUsageOperation:'milana-english-tenses-grading'/u);
 assert.doesNotMatch(english,/ПРИЛОЖЕННОГО PDF/u);
 const physics=code.slice(code.indexOf('const milanaPhysicsService='),code.indexOf('const milanaEnglishTensesService='));
 assert.match(physics,/reasoningEffort:'high'/u);
 assert.match(code,/milanaEnglishTensesService\.isActiveReply\(context\)/u);
 assert.match(code,/milanaPhysicsService\.isActiveReply\(context\)/u);
});
test('physics lessons can continue to send PDFs with questions switched off',async()=>{
 const f=createEnglishFixture();
 try{
  mkdirSync(join(f.root,'Milana','physics'),{recursive:true});mkdirSync(join(f.root,'Milana','theory'),{recursive:true});
  const bank={topics:[1,2,3,4].map(id=>({id,title:'Тема '+id,pdf:id+'.pdf',theoryFile:id+'.txt',
   questions:[{id:id+'-1',question:'Вопрос '+id,referenceAnswer:'Ответ '+id}]}))};
  writeFileSync(join(f.root,'Milana','question-bank.json'),JSON.stringify(bank));
  for(let id=1;id<=4;id++){
   writeFileSync(join(f.root,'Milana','physics',id+'.pdf'),'pdf');
   writeFileSync(join(f.root,'Milana','theory',id+'.txt'),'text');
  }
  const physics=createMilanaPhysicsService({root:f.root,telegramApi:{...f.api,sendDocument:async a=>{
   f.sent.push(a);return {message_id:501+f.sent.length}
  }},clockNow:()=>new Date('2026-11-12T07:00:00Z'),gradeAnswer:async()=>({percent:70,correct:'yes'})});
  await physics.handleMessage(f.owner('физика обучение вопросы выкл'),{isOwner:true});
  assert.equal(physics.snapshot().questionsEnabled,false);
  await physics.tick();
  assert.equal(physics.snapshot().sentTopics.length,1);
  assert.equal(physics.snapshot().active,null);
  await physics.handleMessage(f.owner('физика обучение вопросы вкл'),{isOwner:true});
  await physics.tick();
  assert.ok(physics.snapshot().active);
  await physics.handleMessage(f.owner('физика обучение выкл'),{isOwner:true});
  assert.equal(physics.snapshot().enabled,false);
  await physics.tick();assert.equal(physics.snapshot().sentTopics.length,1);
 }finally{f.cleanup()}
});


test('nightly private quiet hours block all Milana English lesson messages',async()=>{
 const f=createEnglishFixture();
 try{
  f.setTime('2026-11-12T18:30:00Z');
  await f.service.tick();
  assert.equal(f.sent.length,0,'no question or reminder at 21:30 Moscow');
  f.setTime('2026-11-13T06:59:00Z');
  await f.service.tick();
  assert.equal(f.sent.length,0,'none at 09:59 Moscow');
  f.setTime('2026-11-13T07:00:00Z');
  await f.service.tick();
  assert.equal(f.sent.length,1,'question can arrive at 10:00 Moscow');
  const count=f.sent.length;
  f.setTime('2026-11-13T18:31:00Z');
  await f.service.tick();
  assert.equal(f.sent.length,count,'no English repeat or grading messages at 21:31');
 }finally{f.service.stop();f.cleanup()}
});
