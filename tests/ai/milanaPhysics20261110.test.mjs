import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseMilanaPhysicsCommand,knownMilanaTelegramId,createMilanaPhysicsService} from '../../src/features/education/milanaPhysics.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'milana-physics-'));
 for(const dir of ['Milana/physics','Milana/theory','data'])mkdirSync(join(root,dir),{recursive:true});
 const topics=[1,2,3,4,5].map(id=>({id,title:'Тема '+id,pdf:String(id)+'.pdf',theoryFile:String(id)+'.txt',
  questions:Array.from({length:11},(_,i)=>({id:id+'-'+i,question:'Вопрос '+id+'-'+i+'?',referenceAnswer:'Правильно '+id+'-'+i}))}));
 writeFileSync(join(root,'Milana','question-bank.json'),JSON.stringify({version:1,topics}));
 for(const x of topics){writeFileSync(join(root,'Milana','physics',x.pdf),Buffer.from('PDF'));
  writeFileSync(join(root,'Milana','theory',x.theoryFile),'Теория '+x.id);}
 writeFileSync(join(root,'data','telegram-reminders.json'),JSON.stringify({helpNudges:[{id:'milana',chatId:'8019356616',active:false}]}));
 const sent=[];let id=100;let date=new Date('2026-11-10T11:00:00Z');
 const api={sendDocument:async a=>{sent.push({type:'document',...a});return {message_id:++id}},
 sendMessage:async a=>{sent.push({type:'text',...a});return {message_id:++id}},
 call:async(method,args)=>{sent.push({type:'api',method,args})}};
 const grades=[];
 const service=createMilanaPhysicsService({root,telegramApi:api,ownerChatId:'777',
  gradeAnswer:async o=>{grades.push(o);return {percent:84,correct:'Одна часть верна',mistakes:'Не учтена единица',advice:'Повтори закон'};},
  clockNow:()=>date,logger:{error:()=>{},warn:()=>{}}});
 const milanaContext=(text,replyId=0)=>({externalSenderId:'8019356616',externalPeerId:'8019356616',isDM:true,text,
 originalText:text,conversationMessageId:++id,message:{reply_to_message:replyId?{message_id:replyId}:null},
 send:async text=>{sent.push({type:'response',text})}});
 const ownerContext=text=>({externalSenderId:'777',externalPeerId:'777',isDM:true,text,
 originalText:text,send:async text=>{sent.push({type:'response',text})}});
 return {root,topics,sent,service,grades,milanaContext,ownerContext,setDate:v=>date=new Date(v),
 cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('schedule accepts flexible separators and pause/off',()=>{
 assert.deepEqual(parseMilanaPhysicsCommand('физика 3 раза с 10 до 18'),{action:'schedule',slots:['10:00','14:00','18:00']});
 assert.deepEqual(parseMilanaPhysicsCommand('физика 10:15 | 14:00 | 17:55'),{action:'schedule',slots:['10:15','14:00','17:55']});
 assert.equal(parseMilanaPhysicsCommand('физика пауза').action,'pause');
 assert.equal(parseMilanaPhysicsCommand('физика выкл').action,'off');
 assert.equal(parseMilanaPhysicsCommand('физика вопросы').action,'questions');
 assert.equal(parseMilanaPhysicsCommand('не физика'),null);
 assert.equal(parseMilanaPhysicsCommand('физика 09:00 14:00 18:00').action,'invalid');
});
test('initial delivery is immediate, persistent, one question active, read receipt to owner',async()=>{
 const f=fixture();
 try{
  assert.equal(knownMilanaTelegramId(f.root),'8019356616');
  await f.service.tick();
  const state=f.service.snapshot();
  assert.equal(state.firstSentDay,'2026-11-10');
  assert.equal(state.nextTopicId,2);
  assert.equal(state.sentTopics.length,1);
  assert.equal(state.questions.length,2);
  assert.ok(state.active);
  assert.equal(f.sent.filter(x=>x.type==='document').length,1);
  assert.ok(f.sent.some(x=>x.type==='text'&&x.chatId==='777'&&x.text.includes('подготовлены 3 вопроса')));
  await f.service.tick();
  assert.equal(f.sent.filter(x=>x.type==='document').length,1);
  const cb={externalSenderId:'8019356616',externalPeerId:'8019356616',callbackQuery:{data:'milphys:read:1',message:{message_id:101}},
   answerCallbackQuery:async()=>{}};
  assert.equal(await f.service.handleCallback(cb),true);
  assert.equal(await f.service.handleCallback(cb),true);
  assert.equal(f.sent.filter(x=>x.type==='text'&&x.chatId==='777'&&x.text.includes('Прочитала')).length,1);
  assert.equal(Object.keys(f.service.snapshot().read).length,1);
  assert.ok(JSON.parse(readFileSync(join(f.root,'Milana','state.json'),'utf8')).firstSentDay);
 }finally{f.cleanup()}
});
test('reminder every thirty minutes accepts reply to original and grades through provided theory',async()=>{
 const f=fixture();
 try{
  await f.service.tick();
  const first=f.service.snapshot().active.ids[0];
  f.setDate('2026-11-10T11:31:00Z');
  await f.service.tick();
  assert.equal(f.service.snapshot().active.ids.length,2);
  const ctx=f.milanaContext('мой ответ',first);
  assert.equal(await f.service.handleMessage(ctx),true);
  assert.equal(f.grades.length,1);
  assert.equal(f.grades[0].theory,'Теория 1');
  assert.equal(f.service.snapshot().grades[0].percent,84);
  assert.ok(f.service.snapshot().active);
  assert.equal(f.service.snapshot().questions.length,1);
  assert.equal(f.sent.filter(x=>x.type==='text'&&x.chatId==='8019356616'&&x.text.includes('84%')).length,1);
 }finally{f.cleanup()}
});
test('voice transcription is marked for Luna grading, but typed replies are not',async()=>{
 const f=fixture();
 try{
  await f.service.tick();
  const voice=f.milanaContext('запутанная автоматическая транскрипция');
  voice.voiceTranscript='акустически похожая фраза';
  assert.equal(await f.service.handleMessage(voice),true);
  assert.equal(f.grades.length,1);
  assert.equal(f.grades[0].isVoiceTranscript,true);
  assert.equal(f.service.snapshot().grades[0].isVoiceTranscript,true);
  assert.equal(f.grades[0].answer,'акустически похожая фраза');
  const written=f.milanaContext('Обычный текстовый ответ');
  assert.equal(await f.service.handleMessage(written),true);
  assert.equal(f.grades.length,2);
  assert.equal(f.grades[1].isVoiceTranscript,false);
  const {readFileSync}=await import('node:fs');
  const grading=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
  assert.match(grading,/gradeAnswer:async\(\{topic,question,theory,answer,isVoiceTranscript=false\}\)/u);
  assert.match(grading,/ИСТОЧНИК ОТВЕТА: транскрипция голосового сообщения/u);
  assert.match(grading,/фонетические замены/u);
 }finally{f.cleanup()}
});
test('next day sends exactly three PDFs at the configured slots without replacing unanswered question',async()=>{
 const f=fixture();
 try{
  await f.service.tick();
  f.setDate('2026-11-11T07:00:00Z');await f.service.tick();
  f.setDate('2026-11-11T11:00:00Z');await f.service.tick();
  f.setDate('2026-11-11T15:00:00Z');await f.service.tick();
  assert.equal(f.sent.filter(x=>x.type==='document').length,4);
  assert.equal(f.service.snapshot().sentTopics.length,4);
  assert.equal(f.service.snapshot().nextTopicId,5);
  assert.ok(f.service.snapshot().active);
  await f.service.tick();
  assert.equal(f.sent.filter(x=>x.type==='document').length,4);
  await f.service.handleMessage(f.ownerContext('физика пауза'),{isOwner:true});
  f.setDate('2026-11-12T07:00:00Z');await f.service.tick();
  assert.equal(f.sent.filter(x=>x.type==='document').length,4);
 }finally{f.cleanup()}
});


test('nightly private quiet hours prevent Milana physics PDF and quiz messages',async()=>{
 const f=fixture();
 try{
  f.setDate('2026-11-12T18:30:00Z'); // exactly 21:30 Moscow
  await f.service.tick();
  assert.equal(f.sent.length,0,'no new physics PDF, question, owner alert or status at night');
  assert.equal(f.service.snapshot().sentTopics.length,0);
  f.setDate('2026-11-13T06:59:00Z'); // 09:59 Moscow
  await f.service.tick();
  assert.equal(f.sent.length,0);
  f.setDate('2026-11-13T07:00:00Z'); // 10:00 Moscow
  await f.service.tick();
  assert.equal(f.sent.filter(x=>x.type==='document').length,1);
  assert.equal(f.service.snapshot().sentTopics.length,1,'delivered physics topic persisted');
  const count=f.sent.length;
  f.setDate('2026-11-13T18:31:00Z');
  await f.service.tick();
  assert.equal(f.sent.length,count,'no repeat questions or owner reports after 21:30');
 }finally{f.service.stop();f.cleanup()}
});
