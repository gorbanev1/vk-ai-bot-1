import {isHuinglishQuietTime} from '../english/huinglishQuietHours.js';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {knownMilanaTelegramId,normalizeMilanaCommandAlias} from './milanaPhysics.js';

const ZONE='Europe/Moscow', REPEAT_MS=30*60_000, NEXT_DELAY_MS=25*60_000;
const DEFAULT={enabled:true,questionsEnabled:true,recipientChatId:'',
 active:null,used:[],deck:[],grades:[],daily:{},queuedUntil:0,lastError:'',
 nextRetryAt:0,sent:0};
const load=(path,def)=>{try{return JSON.parse(readFileSync(path,'utf8'))}catch{return def}};
function save(path,data){mkdirSync(dirname(path),{recursive:true});const temporary=path+'.'+process.pid+'.tmp';writeFileSync(temporary,JSON.stringify(data,null,2));renameSync(temporary,path)}
function localClock(date){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
  timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',
  minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));
 return {day:[p.year,p.month,p.day].join('-'),minute:Number(p.hour)*60+Number(p.minute)};
}
const eligibleTime=(c)=>c.minute>=600&&c.minute<=1080;
const enabledWord=v=>/^(?:вкл|включить|включено|включена|on)$/u.test(v);
const disabledWord=v=>/^(?:выкл|выключить|выключено|выключена|off)$/u.test(v);

export function parseMilanaEnglishCommand(text){
 const m=normalizeMilanaCommandAlias(text).toLocaleLowerCase('ru-RU')
  .match(/^\/?английские\s+времена(?:\s+обучение)?(?:\s+(.+))?$/u);
 if(!m)return null;
 const suffix=String(m[1]||'').trim();
 const cleaned=suffix.replace(/^включено\s+вкл$/u,'вкл').replace(/^выключено\s+выкл$/u,'выкл');
 if(!cleaned||cleaned==='статус'||cleaned==='обучение'||cleaned==='расписание')return {action:'status'};
 if(enabledWord(cleaned))return {action:'on'};
 if(disabledWord(cleaned))return {action:'off'};
 if(cleaned==='вопросы')return {action:'questions'};
 const q=cleaned.match(/^вопросы\s+(\S+)$/u);
 if(q&&enabledWord(q[1]))return {action:'questions-on'};
 if(q&&disabledWord(q[1]))return {action:'questions-off'};
 return {action:'invalid'};
}

export function createMilanaEnglishTensesService({
 root,telegramApi,ownerChatId='',recipientChatId='',gradeAnswer,
 logger=console,clockNow=()=>new Date(),random=Math.random,shouldDefer=()=>false
}){
 const home=resolve(root,'Milana');
 const bank=load(join(home,'english-tenses-bank.json'),{sections:[],general:[],tickets:[]});
 const questions=[
  ...bank.sections.flatMap(section=>section.questions.map(q=>({
   id:q.id,type:q.type,section:section.title,text:q.text,
   scope:'Система '+section.title
  }))),
  ...bank.general.map(q=>({id:q.id,type:'general',section:q.group,text:q.text,scope:q.group})),
  ...bank.tickets.map(q=>({id:q.id,type:'exam',section:q.tense,text:q.text,
   scope:q.tense,criteria:q.answerOutline})),
 ];
 const map=new Map(questions.map(q=>[q.id,q]));
 const stateFile=join(home,'english-tenses-state.json');
 let state={...structuredClone(DEFAULT),
  recipientChatId:recipientChatId||knownMilanaTelegramId(root),
  ...load(stateFile,{})};
 if(!Array.isArray(state.used))state.used=[];
 if(!Array.isArray(state.deck))state.deck=[];
 if(!state.daily||typeof state.daily!=='object')state.daily={};
 const persist=()=>save(stateFile,state);
 let pending=Promise.resolve(),timer=null,started=false;
 const serial=fn=>{const result=pending.then(fn);pending=result.catch(e=>logger.error('[MILANA ENGLISH]',String(e?.message||e)));return result};
 const educationQuiet=()=>isHuinglishQuietTime(clockNow().getTime(),'Europe/Moscow','private');
 const tmsg=(text,options={})=>{
  if(educationQuiet())throw Error('Education delivery paused until 10:00 Moscow');
  return telegramApi.sendMessage({chatId:state.recipientChatId,text,...options});
 };
 const respond=async(ctx,...args)=>educationQuiet()?false:ctx.send(...args);
 const questionFor=a=>map.get(a?.id);
 const today=()=>localClock(clockNow());
 const nowMs=()=>clockNow().getTime();
 function dailyTarget(c=today()){
  if(!state.daily[c.day]){state.daily[c.day]={target:10+Math.floor(random()*6),asked:0};persist()}
  return state.daily[c.day];
 }
 function fillDeck(){
  const used=new Set(state.used);
  const available=questions.filter(q=>!used.has(q.id));
  if(!available.length){state.used=[];return fillDeck()}
  for(let i=available.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[available[i],available[j]]=[available[j],available[i]]}
  state.deck=available.map(q=>q.id);
  persist();
 }
 async function askNext({force=false}={}){
  if(educationQuiet())return false;
  if(!state.enabled||!state.questionsEnabled||!state.recipientChatId||state.active)return false;
  const c=today(),qday=dailyTarget(c);
  if(!force&&!eligibleTime(c))return false;
  if(qday.asked>=qday.target)return false;
  if(!force&&nowMs()<Number(state.queuedUntil||0))return false;
  if(!state.deck.length)fillDeck();
  const id=state.deck[0],q=map.get(id);
  if(!q){state.deck.shift();persist();return false}
  const text='🇬🇧 Английские времена · '+q.section+'\n\n❓ '+q.text+
   '\n\nОтветь текстом или голосом, можно ответить на это сообщение. Следующий вопрос будет только после ответа.';
  const sent=await tmsg(text);
  state.deck.shift();state.used.push(id);qday.asked++;
  state.active={id,messageIds:[Number(sent?.message_id||0)].filter(Boolean),
   sentAt:clockNow().toISOString(),answer:'',answerMessageId:0,
   isVoiceTranscript:false,grade:null,checking:false,retryAt:0};
  state.sent++;state.queuedUntil=nowMs()+NEXT_DELAY_MS;
  persist();return true;
 }
 async function repeat(){
  if(educationQuiet())return false;
  const a=state.active;
  if(!a||a.answer||!state.enabled||!state.questionsEnabled)return false;
  if(!eligibleTime(today()))return false;
  if(nowMs()-Date.parse(a.sentAt||'')<REPEAT_MS)return false;
  const q=questionFor(a);
  if(!q){state.active=null;persist();return askNext()}
  const msg=await tmsg('🔁 Напоминание по английскому:\n❓ '+q.text+
   '\n\nМожно ответить на любой вариант этого вопроса.');
  a.sentAt=clockNow().toISOString();
  a.messageIds.push(Number(msg?.message_id||0));
  a.messageIds=[...new Set(a.messageIds.filter(Boolean))].slice(-100);
  persist();return true;
 }
 async function gradeCurrent(){
  if(educationQuiet())return false;
  const a=state.active;
  if(!a?.answer||a.checking||!state.enabled||!state.questionsEnabled||nowMs()<Number(a.retryAt||0))return;
  const q=questionFor(a);
  if(!q){state.active=null;persist();return askNext()}
  if(!a.grade){
   a.checking=true;persist();
   try{
    const result=await gradeAnswer({question:q,answer:a.answer,isVoiceTranscript:a.isVoiceTranscript===true});
    const percentage=Number(result?.percent);
    if(!Number.isFinite(percentage)||percentage<0||percentage>100)throw new Error('Luna returned an invalid percentage');
    a.grade={percent:Math.round(percentage),correct:String(result.correct||'').slice(0,850),
     mistakes:String(result.mistakes||'').slice(0,1200),advice:String(result.advice||'').slice(0,850)};
    a.checking=false;persist();
   }catch(error){
    a.checking=false;a.retryAt=nowMs()+300_000;
    state.lastError='Luna grading: '+String(error?.message||error).slice(0,170);
    persist();return;
   }
  }
  const g=a.grade;
  try{
   await tmsg(('🇬🇧 Luna · оценка: '+g.percent+'%.\n\n'+
    '✅ Что правильно: '+(g.correct||'Верные моменты учтены.')+'\n\n'+
    '🔎 Ошибки и недостающие пункты: '+(g.mistakes||'Существенных ошибок не обнаружено.')+'\n\n'+
    '📖 На что обратить внимание: '+(g.advice||'Повтори трудные моменты.')).slice(0,3800),
    {replyToMessageId:a.answerMessageId||null});
  }catch(error){
   a.retryAt=nowMs()+300_000;state.lastError='Grade delivery: '+String(error?.message||error).slice(0,170);
   persist();return;
  }
  state.grades.push({id:a.id,percent:g.percent,answer:a.answer,
   isVoiceTranscript:a.isVoiceTranscript===true,at:clockNow().toISOString()});
  state.grades=state.grades.slice(-1500);state.active=null;persist();
  await askNext();
 }
 async function tickInner(){
  if(educationQuiet()||shouldDefer())return false;
  if(!state.enabled||!state.questionsEnabled||!state.recipientChatId)return;
  if(nowMs()<Number(state.nextRetryAt||0))return;
  try{
   if(state.active?.answer)await gradeCurrent();
   else if(state.active)await repeat();
   else await askNext();
   state.nextRetryAt=0;
  }catch(error){
   state.nextRetryAt=nowMs()+120_000;
   state.lastError=String(error?.message||error).slice(0,190);
   persist();
  }
 }
 const tick=()=>serial(tickInner);
 function status(){
  const c=today(),day=dailyTarget(c);
  return ['🇬🇧 Английские времена: '+(state.enabled?'обучение включено':'обучение выключено'),
   'Вопросы: '+(state.questionsEnabled?'включены':'выключены'),
   'Окно опроса: 10:00–18:00 (Воронеж / Москва)',
   'Сегодня отправлено '+day.asked+' из '+day.target,
   'Всего проверено ответов: '+state.grades.length,
   'Банк: '+questions.length+' вопросов (144 тематических, 45 общих, 12 билетов)',
   'Текущий вопрос: '+(state.active?questionFor(state.active)?.text:'нет'),
   state.lastError?'Последняя ошибка: '+state.lastError:''].filter(Boolean).join('\n');
 }
 const isMilana=ctx=>{
  const sender=String(ctx?.externalSenderId||''),peer=String(ctx?.externalPeerId||'');
  return (ctx?.isDM===true||ctx?.telegramChatType==='private')&&
   sender===String(state.recipientChatId)&&peer===String(state.recipientChatId);
 };
 const isActiveReply=ctx=>{
  if(!isMilana(ctx)||!state.active)return false;
  const id=Number(ctx?.message?.reply_to_message?.message_id||ctx?.replyMessage?.conversationMessageId||0);
  return id>0&&state.active.messageIds.includes(id);
 };
 async function messageInner(ctx,{isOwner=false}={}){
  const admin=isOwner&&(ctx?.isDM===true||ctx?.telegramChatType==='private');
  const milana=isMilana(ctx);
  if(!admin&&!milana)return false;
  const input=String(ctx?.originalText||ctx?.text||'').trim();
  const cmd=parseMilanaEnglishCommand(input);
  if(cmd){
   if(!admin&&!['status'].includes(cmd.action)){
    await respond(ctx,'Управлять обучением может только администратор.');
    return true;
   }
   if(cmd.action==='invalid'){
    await respond(ctx,'Команды: «английские времена обучение вкл/выкл», «английские времена обучение вопросы вкл/выкл», «английские времена обучение статус».');
    return true;
   }
   if(cmd.action==='on'){state.enabled=true;state.questionsEnabled=true}
   if(cmd.action==='off')state.enabled=false;
   if(cmd.action==='questions-on')state.questionsEnabled=true;
   if(cmd.action==='questions-off')state.questionsEnabled=false;
   if(cmd.action==='questions'){
    await respond(ctx,status());return true;
   }
   persist();await respond(ctx,status());
   if(['on','questions-on'].includes(cmd.action))void tick().catch(()=>{});
   return true;
  }
  if(!milana||!state.enabled||!state.questionsEnabled||!state.active)return false;
  const reply=Number(ctx?.message?.reply_to_message?.message_id||ctx?.replyMessage?.conversationMessageId||0);
  if(reply&&!state.active.messageIds.includes(reply))return false;
  const answer=String(ctx?.voiceTranscript||ctx?.originalText||ctx?.text||'').trim();
  if(!answer||answer.length>12_000)return false;
  if(state.active.answer){
   await respond(ctx,'Ответ уже принят, Luna проверяет.');return true;
  }
  state.active.answer=answer;
  state.active.isVoiceTranscript=Boolean(String(ctx?.voiceTranscript||'').trim());
  state.active.answerMessageId=Number(ctx?.conversationMessageId||0);
  state.active.retryAt=0;persist();
  await respond(ctx,'✅ Ответ по английскому принят. Luna проверяет.');
  await gradeCurrent();
  return true;
 }
 const handleMessage=(ctx,options)=>serial(()=>messageInner(ctx,options));
 function start(){
  if(started)return;started=true;
  if(state.active?.checking){state.active.checking=false;persist()}
  timer=setInterval(()=>void tick().catch(error=>logger.error('[MILANA ENGLISH TICK]',String(error?.message||error))),20_000);
  timer.unref?.();
  void tick().catch(error=>logger.error('[MILANA ENGLISH START]',String(error?.message||error)));
 }
 function stop(){if(timer)clearInterval(timer);timer=null;started=false}
 return {start,stop,tick,handleMessage,isMilana,isActiveReply,status,
  snapshot:()=>structuredClone(state),bankCount:questions.length};
}
