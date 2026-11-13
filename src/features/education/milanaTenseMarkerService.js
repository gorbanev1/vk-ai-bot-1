import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {knownMilanaTelegramId} from './milanaPhysics.js';
import {isHuinglishQuietTime} from '../english/huinglishQuietHours.js';
import {makeMarkerTheoryMessages,markerTheoryStats} from './milanaTenseMarkerContent.js';
import {MARKER_QUESTIONS,MARKER_QUESTION_COUNTS} from './milanaTenseMarkerQuestions.js';

export const MARKER_EXIT_BUTTON='🚪 Выйти из режима теста по словам-маркерам';
export const MARKER_RESUME_BUTTON='▶️ Продолжить тест по словам-маркерам';
export function routeTenseMarkerSession(text,{isOwner=false,isMilana=false,isPrivate=true}={}){
 if(!isPrivate)return null;
 const command=parseMilanaTenseMarkerCommand(text);
 if(!command)return null;
 if(isOwner){
  const toMilana=/(?:^|\s)(?:для\s+)?милан[еыа](?:\s|$)/iu.test(String(text||'').toLowerCase().replace(/ё/gu,'е'));
  return {target:toMilana?'milana':'owner',command};
 }
 return isMilana?{target:'milana',command}:null;
}
const QUIZ=new Map(MARKER_QUESTIONS.map(q=>[q.id,q]));
const THEORY=makeMarkerTheoryMessages();
const MAX_MESSAGE_LENGTH=4096;
const escapeHtml=value=>String(value||'').replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');

export function parseMilanaTenseMarkerCommand(input){
 let s=String(input||'').trim().toLowerCase().replace(/ё/gu,'е').replace(/[—–‐‑]/gu,'-');
 s=s.replace(/^\s*[🚪▶️►⏯️ ]+\s*/u,'').trim().replace(/[!.]+$/u,'');
 if(/^выйти\s+из\s+режима\s+теста\s+по\s+словам[\s-]*маркерам$/u.test(s))return {action:'exit'};
 if(/^продолжить\s+тест\s+по\s+словам[\s-]*маркерам$/u.test(s))return {action:'resume'};
 s=s.replace(/^\/?/u,'').replace(/^(?:для\s+)?милан[еыа]\s*[:,]?\s*/u,'').trim();
 const m=s.match(/^слова[\s-]*маркеры\s+времен(?:\s+(.*))?$/u);
 if(!m)return null;
 let rest=String(m[1]||'').trim().replace(/^для\s+милан[еыа]$/u,'').replace(/^милан[еыа]$/u,'').trim();
 rest=rest.replace(/^(?:для\s+)?милан[еыа]\s+/u,'').replace(/\s+(?:для\s+)?милан[еыа]$/u,'').trim();
 if(!rest||/^(?:начать|старт|запуск|вкл|включить)$/u.test(rest))return {action:'start'};
 if(/^(?:пауза|стоп|выход|выйти|выкл)$/u.test(rest))return {action:'exit'};
 if(/^(?:продолжить|возобновить|далее|вкл\s+снова)$/u.test(rest))return {action:'resume'};
 if(/^(?:теория|повторить\s+теорию)$/u.test(rest))return {action:'theory'};
 if(/^(?:вопрос|вопросы|повтор|повторить\s+вопрос)$/u.test(rest))return {action:'repeat'};
 if(/^(?:следующий|пропустить)$/u.test(rest))return {action:'skip'};
 if(/^(?:статус|помощь|команды)$/u.test(rest))return {action:'status'};
 if(/^(?:сброс|сначала)$/u.test(rest))return {action:'reset'};
 return {action:'help'};
}
export const MARKER_GRADING_SYSTEM_PROMPT=[
 'Ты Luna, строгий и объективный экзаменатор английской грамматики. Оценивай СМЫСЛ И ПРАВИЛЬНОСТЬ ответа ученицы на времена, а не количество ключевых слов.',
 'Шкала 0..100 без похвалы за неправильные ответы, никакого автоматического 100%. 100 только при полностью корректном ответе без существенной ошибки. Неполные ответы оцени частично. Неверное время из-за неверной точки отсчёта — существенная ошибка.',
 'Грамматическая ситуация и критерии ответа приоритетнее слова-маркера. Разделяй Present Perfect (результат сейчас) и Past Perfect (готово ДО другого прошлого события), Perfect (завершённый результат) и Perfect Continuous (длительный процесс).',
 'Если source=voice, перед тобой ASR-распознавание голоса: возможны созвучные слова, английские термины, артикли и транслитерация. Разумно восстанавливай предполагаемые слова из контекста, но НЕ додумывай отсутствующие правильные ответы и НЕ завышай оценку.',
 'Если учащийся дал правильный альтернативный вариант или естественный эквивалент, прими и объясни разницу. Если задача просит перевод и объяснение, а этого нет — снижай балл.',
 'Обязательно объясни в корректности и ошибках значение времён, русский перевод трудных слов, как устроена форма глагола и почему другие времена не подходят.',
 'Не сообщай, что это идеальный ответ, если он содержит ошибки. Не используй снисходительные фразы, общую похвалу или воду.',
 'Только JSON {"percent":0,"correct":"конкретные верные части","mistakes":"что неверно или отсутствует","advice":"точный правильный вариант, перевод, объяснение маркеров и смысла"}. Поля percent 0..100, остальные на русском.',
].join('\n');

function localMoscowDay(now){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(x=>[x.type,x.value]));
 return [p.year,p.month,p.day].join('-');
}
function persistJson(file,value){
 mkdirSync(dirname(file),{recursive:true});
 const temporary=file+'.'+process.pid+'.tmp';
 writeFileSync(temporary,JSON.stringify(value,null,2),'utf8');
 renameSync(temporary,file);
}
export function createMilanaTenseMarkerService({
 root,telegramApi,ownerChatId='',gradeAnswer,buildKeyboard=()=>undefined,
 logger=console,clockNow=()=>new Date(),autoStartDay='2026-11-13',
 recipientChatId='',progressFile='',sessionLabel='Миланы'
}={}){
 const stateFile=progressFile?resolve(progressFile):join(resolve(root,'Milana'),'tense-markers-state.json');
 let saved={};try{saved=JSON.parse(readFileSync(stateFile,'utf8'))}catch{}
 const state={
  mode:'idle',recipientChatId:String(recipientChatId||knownMilanaTelegramId(root)),everStarted:false,
  theoryIndex:0,active:null,used:[],grades:[],skips:[],lastError:'',
  nextRetryAt:0,sending:false,startedAt:'',completed:0,autoStartedDay:'',
  ...saved,
 };
 if(recipientChatId)state.recipientChatId=String(recipientChatId);
  if(!Array.isArray(state.used))state.used=[];
 if(!Array.isArray(state.grades))state.grades=[];
 if(!Array.isArray(state.skips))state.skips=[];
 const save=()=>persistJson(stateFile,state);
 let pending=Promise.resolve(),timer=null,started=false;
 const serial=fn=>{const p=pending.then(fn);pending=p.catch(error=>logger.warn('[MILANA MARKERS]',String(error?.message||error).slice(0,190)));return p};
 const now=()=>clockNow();
 const silent=()=>isHuinglishQuietTime(now().getTime(),'Europe/Moscow','private');
 const isMilanaIds=(chatId,userId)=>Boolean(state.recipientChatId&&String(chatId)===String(state.recipientChatId)&&String(userId)===String(state.recipientChatId));
 const isMilana=ctx=>(ctx?.isDM===true||ctx?.telegramChatType==='private')&&isMilanaIds(ctx?.externalPeerId,ctx?.externalSenderId);
 const isRunning=()=>state.mode==='active';
 const keyboard=()=>buildKeyboard(state.mode);
 const tmsg=(text,options={})=>{
  if(!state.recipientChatId)throw Error('No lesson recipient Telegram chat ID');
  if(silent())throw Error('Quiet hours: lesson delivery suspended');
  if(text.length>MAX_MESSAGE_LENGTH)throw Error('Telegram text exceeds 4096 characters');
  return telegramApi.sendMessage({chatId:state.recipientChatId,text,...options});
 };
 async function reply(ctx,text){
  if(ctx?.send)await ctx.send({message:text,replyMarkup:isMilana(ctx)?keyboard():undefined});
 }
 function status(){
  return ['🇬🇧 <b>Тест по словам-маркерам времён</b>',
   'Режим: '+(state.mode==='active'?'идёт':state.mode==='paused'?'пауза':'ещё не запускался'),
   'Теория: '+state.theoryIndex+'/'+THEORY.length+' сообщений',
   'Банк: '+MARKER_QUESTION_COUNTS.all+' смысловых заданий',
   'Проверено ответов: '+state.grades.length,
   'Пропущено: '+state.skips.length,
   'Текущий вопрос: '+(state.active?.id||'нет'),
   state.lastError?'Последний сбой: '+state.lastError:''].filter(Boolean).join('\n');
 }
 function choose(){
  let id=MARKER_QUESTIONS.find(q=>!state.used.includes(q.id))?.id;
  if(!id){state.used=[];id=MARKER_QUESTIONS[0]?.id}
  return id?QUIZ.get(id):null;
 }
 function questionMarkup(q){
  if(q?.type!=='choice'||!Array.isArray(q.options))return keyboard();
  const rows=[];
  for(let i=0;i<q.options.length;i+=2){
   rows.push(q.options.slice(i,i+2).map((text,j)=>({
    text:String(i+j+1)+' · '+String(text).slice(0,45),
    callback_data:'tmq:'+q.id+':'+(i+j),
   })));
  }
  return {inline_keyboard:rows};
 }
 function formattedQuestion(q){
  return [
   '🇬🇧 <b>Слова-маркеры времён · вопрос '+(state.grades.length+state.skips.length+1)+'</b>',
   'Раздел: '+q.group+' / '+q.tense,
   q.type==='oral'?'🎤 <b>УСТНЫЙ ответ</b> (можно и текстом)':
   q.type==='choice'?'🔘 <b>Выбери ответ кнопкой</b> (можно текстом/голосом)':
   q.type==='fill'?'✍️ <b>Вставь форму</b> и по возможности объясни смысл':
   '🧠 <b>Объясни смысл и отличие времён</b>',
   '❓ '+q.text.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;'),
   q.type==='choice'?'Нажми вариант под сообщением.':'Ответь на это сообщение либо следующим текстовым или голосовым.',
   'Луна оценит ответ по существу в процентах и объяснит ошибки.',
  ].join('\n\n');
 }
 async function sendTheory(){
  if(silent()||state.mode!=='active')return false;
  while(state.theoryIndex<THEORY.length){
   const i=state.theoryIndex;
   await tmsg(THEORY[i],{parseMode:'HTML',replyMarkup:keyboard()});
   state.theoryIndex=i+1;save();
  }
  return true;
 }
 async function askNext(){
  if(silent()||state.mode!=='active'||state.active||state.theoryIndex<THEORY.length)return false;
  const q=choose();if(!q)return false;
  const sent=await tmsg(formattedQuestion(q),{parseMode:'HTML',replyMarkup:questionMarkup(q)});
  state.active={
   id:q.id,questionMessageIds:[Number(sent?.message_id||0)].filter(Boolean),
   answer:'',answerMessageId:0,isVoiceTranscript:false,
   checking:false,grade:null,retryAt:0,askedAt:now().toISOString(),
  };
  state.used.push(q.id);save();
  return true;
 }
 async function gradeCurrent(){
  if(silent()||state.mode!=='active')return false;
  const a=state.active;
  if(!a?.answer||a.checking||Date.now()<Number(a.retryAt||0))return false;
  const q=QUIZ.get(a.id);
  if(!q){state.active=null;save();return askNext()}
  if(!a.grade){
   a.checking=true;save();
   try{
    const g=await gradeAnswer({question:q,answer:a.answer,isVoiceTranscript:a.isVoiceTranscript===true});
    const percent=Number(g?.percent);
    if(!Number.isFinite(percent)||percent<0||percent>100)throw Error('Luna invalid grade percentage');
    // A single-choice answer is either right or wrong; Luna still gives commentary.
    const official=q.type==='choice' && q.options.includes(a.answer)
     ?(String(a.answer).trim()===String(q.correct).trim()?100:0)
     :Math.round(percent); // Spoken/open answers use Luna, not an incorrect forced zero.
    a.grade={percent:official,correct:String(g.correct||'').slice(0,1050),
     mistakes:String(g.mistakes||'').slice(0,1400),advice:String(g.advice||'').slice(0,1300)};
    a.checking=false;save();
   }catch(error){
    a.checking=false;a.retryAt=Date.now()+120000;
    state.lastError='Luna grading: '+String(error?.message||error).slice(0,165);
    save();return false;
   }
  }
  const g=a.grade;
  try{
   await tmsg(['🌙 <b>Луна: '+g.percent+'% — объективная оценка</b>',
    '✅ <b>Верно:</b> '+escapeHtml(g.correct||'Верные элементы не указаны.'),
    '❌ <b>Ошибки / пробелы:</b> '+escapeHtml(g.mistakes||'Ключевых ошибок нет.'),
    '📘 <b>Правильный смысл и правило:</b> '+escapeHtml(g.advice||q.expected+'; '+q.why),
   ].join('\n\n').slice(0,3900),{
    parseMode:'HTML',
    replyToMessageId:a.answerMessageId||undefined,
    replyMarkup:keyboard(),
   });
  }catch(error){
   a.retryAt=Date.now()+120000;
   state.lastError='Luna feedback delivery: '+String(error?.message||error).slice(0,165);
   save();return false;
  }
  state.grades.push({id:a.id,answer:a.answer,voice:a.isVoiceTranscript,percent:g.percent,at:now().toISOString()});
  state.grades=state.grades.slice(-1200);
  state.completed++;state.active=null;state.lastError='';save();
  return askNext();
 }
 async function acceptAnswer(answer,{isVoiceTranscript=false,answerMessageId=0}={}){
  const a=state.active;
  if(state.mode!=='active'||!a||!String(answer||'').trim()||String(answer).length>12000)return false;
  if(a.answer)return true;
  a.answer=String(answer).trim();a.answerMessageId=Number(answerMessageId)||0;
  a.isVoiceTranscript=Boolean(isVoiceTranscript);a.retryAt=0;save();
  await gradeCurrent();return true;
 }
 async function tickInner(){
  if(silent()||state.mode!=='active'||Date.now()<Number(state.nextRetryAt||0))return false;
  try{
   if(state.theoryIndex<THEORY.length)await sendTheory();
   if(state.active?.answer)await gradeCurrent();
   if(!state.active)await askNext();
   state.nextRetryAt=0;return true;
  }catch(error){
   state.nextRetryAt=Date.now()+120000;state.lastError=String(error?.message||error).slice(0,175);
   save();logger.warn('[MILANA MARKERS TICK]',state.lastError);return false;
  }
 }
 const tick=()=>serial(tickInner);
 async function begin({reset=false,redeliverTheory=false}={}){
  if(reset){state.used=[];state.grades=[];state.skips=[];state.active=null;state.completed=0}
  if(redeliverTheory||!state.everStarted)state.theoryIndex=0;
  state.mode='active';state.everStarted=true;state.startedAt=now().toISOString();save();
  await tickInner();
  return true;
 }
 async function repeatQuestion(){
  if(state.mode!=='active'||!state.active)return false;
  const q=QUIZ.get(state.active.id);if(!q)return false;
  const sent=await tmsg(formattedQuestion(q),{parseMode:'HTML',replyMarkup:questionMarkup(q)});
  const id=Number(sent?.message_id||0);if(id)state.active.questionMessageIds.push(id);
  state.active.questionMessageIds=[...new Set(state.active.questionMessageIds)].slice(-50);
  save();return true;
 }
 const isActiveReply=ctx=>{
  if(!isMilana(ctx)||state.mode!=='active'||!state.active)return false;
  const replyId=Number(ctx?.message?.reply_to_message?.message_id||ctx?.replyMessage?.conversationMessageId||0);
  return replyId>0&&state.active.questionMessageIds.includes(replyId);
 };
 const isActiveFor=ctx=>isMilana(ctx)&&state.mode==='active';
 async function messageInner(ctx,{isOwner=false}={}){
  const milana=isMilana(ctx),admin=isOwner&&(ctx?.isDM===true||ctx?.telegramChatType==='private');
  if(!milana&&!admin)return false;
  const input=String(ctx?.voiceTranscript||ctx?.originalText||ctx?.text||'').trim();
  const cmd=parseMilanaTenseMarkerCommand(input);
  if(cmd){
   const action=cmd.action;
   if(['start','reset','theory','skip','exit','resume'].includes(action)&&!admin&&!milana)return false;
   if(action==='start'){
    if(state.mode==='active'&&state.active){await reply(ctx,'Тест уже идёт. '+status());return true}
    await begin();await reply(ctx,'✅ Тест по временам запущен: '+sessionLabel+'. '+status());return true;
   }
   if(action==='resume'){
    if(state.mode==='idle'){await begin()}else{state.mode='active';save();await tickInner();if(state.active)await repeatQuestion()}
    await reply(ctx,'▶️ Тест по словам-маркерам продолжен.');return true;
   }
   if(action==='exit'){
    state.mode='paused';save();
    await tmsg('⏸ Тест приостановлен. Прогресс сохранён. Нажми «Продолжить тест по словам-маркерам», когда будешь готова.',{replyMarkup:keyboard()});
    if(admin&&!milana)await reply(ctx,'Режим теста '+sessionLabel+' остановлен.');return true;
   }
   if(action==='theory'){
    if(state.mode!=='active')state.mode='active';
    state.theoryIndex=0;save();await tickInner();
    await reply(ctx,'📚 Теория по временам повторно отправлена: '+sessionLabel+'.');return true;
   }
   if(action==='repeat'){
    if(state.mode==='active')await repeatQuestion();
    await reply(ctx,status());return true;
   }
   if(action==='skip'){
    if(state.active){state.skips.push({id:state.active.id,at:now().toISOString()});state.active=null;save();}
    if(state.mode==='active')await askNext();
    await reply(ctx,'Вопрос пропущен, новый отправлен.');return true;
   }
   if(action==='reset'){
    if(!admin){await reply(ctx,'Сброс прогресса доступен только владельцу.');return true}
    await begin({reset:true,redeliverTheory:true});await reply(ctx,'🔄 Тест сброшен и запущен с теории: '+sessionLabel+'.');return true;
   }
   await reply(ctx,status()+'\n\nКоманды: «слова маркеры времен», «слова маркеры времен милане», «слова маркеры времен статус/теория/повтор/следующий/сброс», кнопки «Выйти» и «Продолжить».');return true;
  }
  if(!milana||state.mode!=='active'||!state.active)return false;
  const replyId=Number(ctx?.message?.reply_to_message?.message_id||ctx?.replyMessage?.conversationMessageId||0);
  if(replyId&&!state.active.questionMessageIds.includes(replyId))return false;
  if(!input)return false;
  if(state.active.answer){await reply(ctx,'Ответ уже принят, Луна проверяет.');return true}
  await acceptAnswer(input,{isVoiceTranscript:Boolean(String(ctx?.voiceTranscript||'').trim()),answerMessageId:ctx?.conversationMessageId||0});
  return true;
 }
 async function callbackInner(ctx){
  const data=String(ctx?.callbackQuery?.data||'');
  const match=data.match(/^tmq:(TM\d{3}):([0-3])$/u);
  if(!match)return false;
  if(!isMilana(ctx)){
   await ctx.answerCallbackQuery?.({text:'Это задание другого участника.',showAlert:true}).catch(()=>{});return true;
  }
  const q=QUIZ.get(match[1]),idx=Number(match[2]);
  if(!q||state.mode!=='active'||state.active?.id!==q.id||q.type!=='choice'||idx>=q.options.length){
   await ctx.answerCallbackQuery?.({text:'Это старый вопрос. Смотри последний.'}).catch(()=>{});return true;
  }
  await ctx.answerCallbackQuery?.({text:'Ответ принят; Луна проверяет.'}).catch(()=>{});
  if(state.active.answer)return true;
  await acceptAnswer(q.options[idx],{answerMessageId:Number(ctx?.callbackQuery?.message?.message_id||0)});
  return true;
 }
 const handleMessage=(ctx,options)=>serial(()=>messageInner(ctx,options));
 const handleCallback=ctx=>serial(()=>callbackInner(ctx));
 function start(){
  if(started)return;started=true;
  if(state.active?.checking){state.active.checking=false;save()}
  timer=setInterval(()=>void tick().catch(error=>logger.warn('[MILANA MARKERS]',String(error?.message||error))),20_000);
  timer.unref?.();
  if(!state.everStarted&&state.mode==='idle'&&autoStartDay&&localMoscowDay(now())===autoStartDay&&!silent()){
   void serial(()=>begin()).catch(error=>logger.warn('[MILANA MARKERS AUTOSTART]',String(error?.message||error)));
  }else if(state.mode==='active'){void tick().catch(()=>{})}
 }
 const stop=()=>{if(timer)clearInterval(timer);timer=null;started=false};
 return {start,stop,tick,handleMessage,handleCallback,isMilana,isMilanaIds,isActiveFor,isActiveReply,
  mode:()=>state.mode,status,snapshot:()=>structuredClone(state),bankCount:MARKER_QUESTIONS.length,
  theoryStats:markerTheoryStats()};
}
