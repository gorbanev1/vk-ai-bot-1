import {isHuinglishQuietTime} from '../english/huinglishQuietHours.js';
import { existsSync,mkdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs';
import { basename,dirname,join,resolve } from 'node:path';

const TIMEZONE='Europe/Moscow', THIRTY_MINUTES=30*60_000;
const DEFAULT_SLOTS=['10:00','14:00','18:00'];
const DEFAULT_STATE={enabled:true,questionsEnabled:true,paused:false,slots:DEFAULT_SLOTS,nextTopicId:1,firstSentDay:'',
 sentTopics:[],read:{},questions:[],active:null,usedQuestions:[],askedByDay:{},grades:[],
 sentSlots:{},pendingOwnerMessages:[],retryAt:0,sending:null,lastError:''};
const load=(p,def)=>{try{return JSON.parse(readFileSync(p,'utf8'))}catch{return def}};
function save(p,value){mkdirSync(dirname(p),{recursive:true});const tmp=p+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2));renameSync(tmp,p)}
function time(now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',
 day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
 return {day:[p.year,p.month,p.day].join('-'),minute:Number(p.hour)*60+Number(p.minute)};
}
const minute=s=>{const m=String(s||'').match(/^([01]?\d|2[0-3])(?::([0-5]\d))?$/u);return m?Number(m[1])*60+Number(m[2]||0):null};
const formatted=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');

export function normalizeMilanaCommandAlias(input){
 return String(input||'').trim().replace(/^\/?милане(?:\s*[:,—-]\s*|\s+)/iu,'').trim();
}
export function parseMilanaPhysicsCommand(input){
 const m=normalizeMilanaCommandAlias(input).match(/^\/?физика(?:\s+([\s\S]*))?$/iu);if(!m)return null;
 const a=String(m[1]||'').trim().toLowerCase();
 const commands={статус:'status',расписание:'status',пауза:'pause',выкл:'off',выключить:'off',
  вкл:'on',включить:'on',вопросы:'questions',повтор:'repeat'};
 if(!a)return {action:'status'};
 if(commands[a])return {action:commands[a]};
 const learning=a.match(/^обучение(?:\s+(.+))?$/u);
 if(learning){
  const suffix=String(learning[1]||'').trim();
  if(!suffix||suffix==='статус')return {action:'status'};
  if(/^(?:вкл|включить|включено)$/u.test(suffix))return {action:'on'};
  if(/^(?:выкл|выключить|выключено)$/u.test(suffix))return {action:'off'};
  if(suffix==='вопросы')return {action:'status'};
  if(/^вопросы\s+(?:вкл|включить|включено)$/u.test(suffix))return {action:'questions-on'};
  if(/^вопросы\s+(?:выкл|выключить|выключено)$/u.test(suffix))return {action:'questions-off'};
  return {action:'invalid'};
 }
 const target=a.match(/^кому\s+(\d{5,20})$/u);if(target)return {action:'recipient',id:target[1]};
 const range=a.match(/(?:3\s+раза\s+)?с\s+(\d{1,2}(?::\d{2})?)\s+до\s+(\d{1,2}(?::\d{2})?)/u);
 if(range){const start=minute(range[1]),end=minute(range[2]);
  if(start==null||end==null||start>=end||start<600||end>1080)return {action:'invalid'};
  return {action:'schedule',slots:[formatted(start),formatted(Math.round((start+end)/2)),formatted(end)]};}
 const clean=a.replace(/^3\s+раза\s*/u,'');
 const matches=clean.match(/\d{1,2}(?::\d{2})?/gu)||[];
 const extra=clean.replace(/\d{1,2}(?::\d{2})?/gu,'').replace(/[\s,;./|\-]+/gu,'');
 const times=matches.map(minute);
 if(!extra&&times.length===3&&times.every(t=>t!=null&&t>=600&&t<=1080)&&times[0]<times[1]&&times[1]<times[2])
  return {action:'schedule',slots:times.map(formatted)};
 return {action:'invalid'};
}
export function knownMilanaTelegramId(root){
 const data=load(join(root,'data','telegram-reminders.json'),{});
 for(const key of ['helpNudges','reminders'])for(const item of Array.isArray(data[key])?data[key]:[])
  if(/^milana(?:-|$)/iu.test(String(item?.id||''))&&/^\d{5,20}$/u.test(String(item?.chatId||'')))return String(item.chatId);
 return '';
}
export function createMilanaPhysicsService({root,telegramApi,ownerChatId='',recipientChatId='',gradeAnswer,
 logger=console,clockNow=()=>new Date(),sendInitialImmediately=true,shouldDefer=()=>false}){
 const folder=resolve(root,'Milana'),statePath=join(folder,'state.json');
 const bank=load(join(folder,'question-bank.json'),{topics:[]});
 let state={...structuredClone(DEFAULT_STATE),recipientChatId:recipientChatId||knownMilanaTelegramId(root),...load(statePath,{})};
 const persist=()=>save(statePath,state);
 const topic=id=>bank.topics.find(t=>t.id===Number(id));
 const question=entry=>topic(entry?.topicId)?.questions.find(q=>q.id===entry?.id);
 let chain=Promise.resolve(),timer=null,started=false;
 const sequential=work=>{const current=chain.then(work);chain=current.catch(e=>logger.error('[MILANA PHYSICS]',String(e?.message||e)));return current};
 const educationQuiet=()=>isHuinglishQuietTime(clockNow().getTime(),'Europe/Moscow','private');
 const telegram=(chatId,text,options={})=>{
  if(educationQuiet())throw Error('Education delivery paused until 10:00 Moscow');
  return telegramApi.sendMessage({chatId,text,...options});
 };
 const respond=async(ctx,...args)=>educationQuiet()?false:ctx.send(...args);
 async function notifyOwner(message){
  if(!ownerChatId)return;
  try{await telegram(ownerChatId,message)}
  catch(e){state.pendingOwnerMessages.push(message);state.pendingOwnerMessages=state.pendingOwnerMessages.slice(-100);persist()}
 }
 async function flushOwner(){
  while(ownerChatId&&state.pendingOwnerMessages.length){
   try{await telegram(ownerChatId,state.pendingOwnerMessages[0]);state.pendingOwnerMessages.shift();persist()}catch{return}
  }
 }
 function enqueueQuestions(t,count){
  if(!t)return;
  const used=new Set([...state.usedQuestions,...state.questions.map(x=>x.id),state.active?.id].filter(Boolean));
  const pool=t.questions.filter(q=>!used.has(q.id));
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]]}
  state.questions.push(...pool.slice(0,count).map(q=>({topicId:t.id,id:q.id})));
  persist();
 }
 async function askNext(){
  if(educationQuiet())return false;
  if(!state.enabled||!state.questionsEnabled||state.paused||!state.recipientChatId||state.active||!state.questions.length)return false;
  const day=time(clockNow()).day;
  if(Number(state.askedByDay[day]||0)>=15)return false;
  const entry=state.questions[0],q=question(entry);
  if(!q){state.questions.shift();persist();return askNext()}
  const msg=await telegram(state.recipientChatId,'📘 Физика · тема '+entry.topicId+
   '\n❓ '+q.question+'\n\nОтветь текстом или голосом. Можно отвечать на любое повторение этого вопроса.');
  state.questions.shift();
  state.active={...entry,ids:[Number(msg?.message_id||0)].filter(Boolean),
   lastSentAt:clockNow().toISOString(),answer:'',answerMessageId:0,checking:false,retryAt:0,grade:null};
  state.usedQuestions.push(entry.id);state.askedByDay[day]=Number(state.askedByDay[day]||0)+1;persist();
  return true;
 }
 async function sendTopic(t,{first=false,slot=''}={}){
  if(educationQuiet())return false;
  if(!t||!state.recipientChatId)return false;
  const pdf=join(folder,'physics',t.pdf);if(!existsSync(pdf))throw new Error('Missing PDF topic '+t.id);
  const day=time(clockNow()).day;
  state.sending={topicId:t.id,day,slot,startedAt:clockNow().toISOString()};persist();
  let delivered;
  try{delivered=await telegramApi.sendDocument({chatId:state.recipientChatId,
   document:{filePath:pdf,filename:basename(pdf),mimeType:'application/pdf'},
   caption:'📚 Физика · часть '+t.id+'/21\n'+t.title+'\n\nКогда изучишь, нажми «Прочитала».',
   replyMarkup:{inline_keyboard:[[{text:'✅ Прочитала',callback_data:'milphys:read:'+t.id}]]}})}
  catch(e){state.sending=null;state.retryAt=Date.now()+300_000;state.lastError='PDF: '+String(e?.message||e).slice(0,190);persist();throw e}
  state.sending=null;state.retryAt=0;state.nextTopicId=Math.max(Number(state.nextTopicId||1),t.id+1);
  state.sentTopics.push({topicId:t.id,day,slot,messageId:Number(delivered?.message_id||0),at:clockNow().toISOString()});
  if(first)state.firstSentDay=day;
  if(slot){state.sentSlots[day]??=[];state.sentSlots[day].push(slot)}
  persist();enqueueQuestions(t,first?3:4);
  await notifyOwner(first?'✅ Милане ДОСТАВЛЕНА первая часть теории: '+t.title+
    '. По ней подготовлены 3 вопроса; первый отправляется сразу. Завтра 3 части по расписанию '+
    state.slots.join(', ')+' (Москва).':
    '📚 Милане доставлена часть '+t.id+'/21: '+t.title+'. Добавлены 4 вопроса.');
  await askNext();return true;
 }
 async function repeat(force=false){
  if(educationQuiet())return false;
  const a=state.active;if(!a||a.answer||!state.questionsEnabled)return false;
  if(!force&&Date.now()-Date.parse(a.lastSentAt||'')<30*60_000)return false;
  const q=question(a);if(!q){state.active=null;persist();await askNext();return false}
  const msg=await telegram(state.recipientChatId,'🔁 Повтор вопроса:\n❓ '+q.question+
   '\n\nМожно ответить на это сообщение или на любое предыдущее с тем же вопросом.');
  a.ids.push(Number(msg?.message_id||0));a.ids=[...new Set(a.ids.filter(Boolean))].slice(-100);
  a.lastSentAt=clockNow().toISOString();persist();return true;
 }
 async function evaluate(){
  if(educationQuiet())return false;
  const a=state.active;if(!state.questionsEnabled||!a?.answer||a.checking||Date.now()<Number(a.retryAt||0))return;
  const t=topic(a.topicId),q=question(a);
  if(!t||!q){state.active=null;persist();await askNext();return}
  if(!a.grade){
   a.checking=true;persist();
   try{
    const theory=readFileSync(join(folder,'theory',t.theoryFile),'utf8');
    const g=await gradeAnswer({topic:t,question:q,theory,answer:a.answer,isVoiceTranscript:a.isVoiceTranscript===true});
    const value=Number(g?.percent);if(!Number.isFinite(value)||value<0||value>100)throw new Error('Invalid score from Luna');
    a.grade={percent:Math.round(value),correct:String(g.correct||'').slice(0,1000),
     mistakes:String(g.mistakes||'').slice(0,1300),advice:String(g.advice||'').slice(0,800)};
    a.checking=false;persist();
   }catch(e){a.checking=false;a.retryAt=Date.now()+300_000;state.lastError='Luna: '+String(e?.message||e).slice(0,180);persist();return}
  }
  try{
   const g=a.grade;
   await telegram(state.recipientChatId,('🌙 Luna (высокий интеллект): '+g.percent+'% правильно.'+
    '\n\n✅ '+(g.correct||'Верные мысли учтены.')+'\n\n🔎 Неточности: '+(g.mistakes||'Существенных нет.')+
    '\n\n💡 '+(g.advice||'Повтори сложные моменты.')).slice(0,3800),
    {replyToMessageId:a.answerMessageId||null});
  }catch(e){a.retryAt=Date.now()+300_000;state.lastError='Answer delivery: '+String(e?.message||e).slice(0,180);persist();return}
  state.grades.push({id:a.id,topicId:a.topicId,answer:a.answer,isVoiceTranscript:a.isVoiceTranscript===true,percent:a.grade.percent,at:clockNow().toISOString()});
  state.grades=state.grades.slice(-1000);state.active=null;persist();await askNext();
 }
 async function tickInner(){
  if(educationQuiet()||shouldDefer())return false;
  if(!state.enabled||state.paused||!state.recipientChatId||!bank.topics.length)return;
  await flushOwner();
  if(state.sending){
   if(Date.now()-Date.parse(state.sending.startedAt)>900_000&&!state.sending.notified){
    state.sending.notified=true;persist();
    await notifyOwner('⚠️ Отправка части '+state.sending.topicId+' прервалась в неизвестном состоянии. Проверь чат Миланы; команда «физика повтор» разрешает повтор.');
   }return;
  }
  if(Date.now()<Number(state.retryAt||0))return;
  if(!state.firstSentDay){if(sendInitialImmediately)await sendTopic(topic(state.nextTopicId),{first:true});return}
  const local=time(clockNow());
  if(local.day!==state.firstSentDay&&local.minute<=1080){
   const todaySent=state.sentTopics.filter(s=>s.day===local.day&&s.slot).length;
   if(todaySent<3)for(const slot of state.slots){
    if(local.minute<minute(slot)||(state.sentSlots[local.day]||[]).includes(slot))continue;
    const t=topic(state.nextTopicId);if(!t)break;
    await sendTopic(t,{slot});break;
   }
  }
  if(state.questionsEnabled){
   if(state.active?.answer)await evaluate();
   else if(state.active)await repeat();
   else await askNext();
  }
 }
 const tick=()=>sequential(tickInner);
 function status(){return ['📚 Физика Миланы: '+(!state.enabled?'выключена':state.paused?'пауза':'включена'),
  'Вопросы: '+(state.questionsEnabled?'включены':'выключены'),'Расписание (Москва): '+state.slots.join(', '),'Тем доставлено: '+state.sentTopics.length+'/21',
  'Прочитано: '+Object.keys(state.read).length,'Проверено ответов: '+state.grades.length,
  'Вопросов в очереди: '+state.questions.length,'Текущий: '+(state.active?question(state.active)?.question:'нет'),
  state.lastError?'Последний сбой: '+state.lastError:''].filter(Boolean).join('\n')}
 async function messageInner(ctx,{isOwner=false}={}){
  const sender=String(ctx?.externalSenderId||''),peer=String(ctx?.externalPeerId||'');
  const dm=ctx?.isDM===true||ctx?.telegramChatType==='private';
  const milana=dm&&sender===String(state.recipientChatId)&&peer===String(state.recipientChatId);
  const admin=dm&&isOwner;
  if(!milana&&!admin)return false;
  const raw=String(ctx?.voiceTranscript||ctx?.originalText||ctx?.text||'').trim();
  const cmd=parseMilanaPhysicsCommand(raw);
  if(cmd){
   if(!admin&&!['status','questions'].includes(cmd.action)){await respond(ctx,'Расписание меняет только администратор.');return true}
   if(cmd.action==='invalid'){await respond(ctx,'Пример: «физика 3 раза с 10 до 18» либо «физика 10:15,14:00,18:00». Команды: пауза, вкл, выкл, вопросы, статус.');return true}
   if(cmd.action==='questions-off')state.questionsEnabled=false;
   if(cmd.action==='questions-on')state.questionsEnabled=true;
   if(cmd.action==='pause')state.paused=true;
   if(cmd.action==='off'){state.enabled=false;state.paused=false}
   if(cmd.action==='on'){state.enabled=true;state.paused=false}
   if(cmd.action==='schedule'){state.slots=[...cmd.slots];state.enabled=true;state.paused=false}
   if(cmd.action==='recipient')state.recipientChatId=cmd.id;
   if(cmd.action==='repeat'){
    if(state.sending){state.sending=null;state.retryAt=0}
    else if(state.active)await repeat(true);
    else await askNext();
   }
   if(cmd.action==='questions'){
    if(!state.active&&!state.questions.length){
     const last=state.sentTopics.at(-1);if(last)enqueueQuestions(topic(last.topicId),3);
    }
    await askNext();
   }
   persist();await respond(ctx,status());return true;
  }
  if(!milana||!state.enabled||!state.questionsEnabled||state.paused||!state.active)return false;
  const reply=Number(ctx?.message?.reply_to_message?.message_id||ctx?.replyMessage?.conversationMessageId||0);
  if(reply&&!state.active.ids.includes(reply))return false;
  const answer=String(ctx?.voiceTranscript||ctx?.originalText||ctx?.text||'').trim();
  if(!answer||answer.length>12000)return false;
  if(state.active.answer){await respond(ctx,'Ответ принят. Luna проверяет; следующий вопрос придёт после оценки.');return true}
  state.active.answer=answer;state.active.isVoiceTranscript=Boolean(String(ctx?.voiceTranscript||'').trim());state.active.answerMessageId=Number(ctx?.conversationMessageId||0);state.active.retryAt=0;
  persist();await respond(ctx,'✅ Ответ принят. Проверяю по теории этой темы.');
  await evaluate();return true;
 }
 const handleMessage=(ctx,options)=>sequential(()=>messageInner(ctx,options));
 async function callbackInner(ctx){
  const cb=ctx?.callbackQuery;const m=String(cb?.data||'').match(/^milphys:read:(\d{1,2})$/u);if(!m)return false;
  if(String(ctx?.externalSenderId||'')!==String(state.recipientChatId)||String(ctx?.externalPeerId||'')!==String(state.recipientChatId)){
   await ctx.answerCallbackQuery({text:'Кнопка только для Миланы.',showAlert:true});return true}
  const id=Number(m[1]);if(!state.sentTopics.some(t=>t.topicId===id)){
   await ctx.answerCallbackQuery({text:'Тема не найдена.'});return true}
  if(!state.read[id]){
   state.read[id]={at:clockNow().toISOString(),messageId:Number(cb?.message?.message_id||0)};persist();
   await notifyOwner('✅ Милана нажала «Прочитала»: часть '+id+'/21 — '+(topic(id)?.title||'физика'))}
  await ctx.answerCallbackQuery({text:'Прочитала ✅'}).catch(()=>{});
  if(cb?.message?.message_id)await telegramApi.call('editMessageReplyMarkup',{
   chat_id:state.recipientChatId,message_id:cb.message.message_id,reply_markup:{inline_keyboard:[]}},
   {timeoutMs:10000}).catch(()=>{});
  return true;
 }
 const handleCallback=ctx=>sequential(()=>callbackInner(ctx));
 function start(){
  if(started)return;started=true;
  if(state.active?.checking){state.active.checking=false;persist()}
  timer=setInterval(()=>void tick().catch(e=>logger.warn('[MILANA PHYSICS TICK]',String(e?.message||e))),20000);
  timer.unref?.();
  void tick().catch(e=>logger.error('[MILANA PHYSICS INITIAL]',String(e?.message||e)));
 }
 function stop(){if(timer)clearInterval(timer);timer=null;started=false}
 function isActiveReply(ctx){
  const reply=Number(ctx?.message?.reply_to_message?.message_id||ctx?.replyMessage?.conversationMessageId||0);
  return reply>0&&state.active?.ids?.includes(reply)===true;
 }
 return {start,stop,tick,handleMessage,handleCallback,isActiveReply,status,snapshot:()=>JSON.parse(JSON.stringify(state))};
}
