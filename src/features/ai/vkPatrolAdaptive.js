import {readJsonlTail} from './vkPatrolLogTail.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {appendFileSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

export const PATROL_PEER_ID=2000000011;
export const PATROL_DAILY_TOKEN_LIMIT=10_000_000;
export const PATROL_REQUEST_TOKEN_LIMIT=3_000_000;
export const PATROL_REQUEST_TOKEN_ADVISORY=300_000;
export const PATROL_MAX_STEPS=24;
export const PATROL_MAX_REFS_PER_PERSON=4;
export const PATROL_MAX_REFS_TOTAL=6;
const storage=new AsyncLocalStorage();
const base=resolve(process.env.GIGORAVE_DATA_DIR||'./data','vk-patrol-adaptive');
let reserved=0;
function location(name){mkdirSync(base,{recursive:true});return join(base,name)}
function load(path,fallback){try{return JSON.parse(readFileSync(path,'utf8'))}catch{return fallback}}
function save(path,value){mkdirSync(dirname(path),{recursive:true});const tmp=path+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2));renameSync(tmp,path)}
function log(name,row){appendFileSync(location(name),JSON.stringify(row)+'\n','utf8')}
function dayParts(now=new Date(),zone='Europe/Moscow'){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
 return {day:[p.year,p.month,p.day].join('-'),minute:Number(p.hour)*60+Number(p.minute)};
}
function yesterday(day){const [y,m,d]=day.split('-').map(Number);return new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10)}
const patrolTrackingStart=location('tracking-start.json');
if(!load(patrolTrackingStart,null))save(patrolTrackingStart,{day:dayParts().day});
function records(filename){try{return readFileSync(location(filename),'utf8').split(/\r?\n/u).filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean)}catch{return []}}
export function isPatrolPeer(id){return Number(id)===PATROL_PEER_ID}
const adaptiveSettingPath=location('adaptive-mode.json');
export function parsePatrolAdaptiveToggleCommand(text){
 const clean=String(text||'').trim()
  .replace(/^(?:\u0433\u0438\u0433\u043e\u0440\u0435\u0439\u0432|gigorave)[\s,:!-]+/iu,'')
  .replace(/[.!?]+$/u,'').trim();
 const alias=clean.replace(/^(?:\u0430\u0433\u0435\u043d\u0442\u043d\u044b\u0439|\u0438\u043d\u0442\u0435\u043b\u043b\u0435\u043a\u0442\u0443\u0430\u043b\u044c\u043d\u044b\u0439)\s+\u0440\u0435\u0436\u0438\u043c/iu,
  '\u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c');
 const m=alias.match(/^\u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0439\s+\u0440\u0435\u0436\u0438\u043c(?:\s+(\u0432\u043a\u043b|\u0432\u043a\u043b\u044e\u0447\u0438\u0442\u044c|\u0432\u044b\u043a\u043b|\u0432\u044b\u043a\u043b\u044e\u0447\u0438\u0442\u044c|\u0441\u0442\u0430\u0442\u0443\u0441))?$/iu);
 if(!m)return null;
 const action=String(m[1]||'').toLocaleLowerCase('ru-RU');
 return {action:action.startsWith('\u0432\u043a\u043b')?'enable':
  action.startsWith('\u0432\u044b\u043a\u043b')?'disable':'status'};
}
export function isPatrolAdaptiveEnabled(peerId=PATROL_PEER_ID){
 if(!isPatrolPeer(peerId))return false;
 const state=load(adaptiveSettingPath,null);
 if(!state||state.peerId!==PATROL_PEER_ID)return true;
 return state.enabled!==false;
}
export function setPatrolAdaptiveEnabled(peerId,enabled,{actorId=0}={}){
 if(!isPatrolPeer(peerId))throw new Error('Adaptive mode may only be configured in the target VK chat');
 const state={peerId:PATROL_PEER_ID,enabled:Boolean(enabled),
  actorId:Number(actorId)||0,updatedAt:new Date().toISOString()};
 save(adaptiveSettingPath,state);
 log('adaptive-mode-changes.jsonl',state);
 return state;
}
export function patrolActiveScope(){return storage.getStore()||null}
export function patrolRequestTokenRemaining(){
 const scope=storage.getStore();
 if(!isPatrolPeer(scope?.peerId))return PATROL_REQUEST_TOKEN_LIMIT;
 return Math.max(0,PATROL_REQUEST_TOKEN_LIMIT-Math.max(0,Number(scope.tokensUsed)||0));
}
export function patrolBudgetGuidance(){
 const scope=storage.getStore();
 if(!isPatrolPeer(scope?.peerId)||scope.adaptive===false||Number(scope.tokensUsed)<PATROL_REQUEST_TOKEN_ADVISORY)return '';
 return 'Расход на запрос уже '+Number(scope.tokensUsed).toLocaleString('ru-RU')+' токенов. Желательно скорее завершить полезный ответ, используя собранные результаты и избегая повторов. Это пожелание, не запрет продолжать необходимые проверки. Не объявляй незавершённую задачу выполненной.';
}
export function patrolCanCallModel(expectedMaxTokens=20000){
 return patrolRequestTokenRemaining()>=Math.max(1000,Number(expectedMaxTokens)||20000);
}
function traceRow(scope,kind,fields={}){
 const row={at:new Date().toISOString(),peerId:scope.peerId,
  requestId:scope.requestId,kind,...fields};
 log('full-trace-'+dayParts().day+'.jsonl',row);
 scope.events=(scope.events||0)+1;
 const key=createHash('sha256').update(String(scope.requestId)).digest('hex').slice(0,22);
 save(location('checkpoints/'+key+'.json'),{
  version:1,requestId:scope.requestId,peerId:scope.peerId,
  status:scope.finalStatus||'in_progress',tokensUsed:Number(scope.tokensUsed)||0,
  limit:PATROL_REQUEST_TOKEN_LIMIT,steps:scope.events,
  lastAction:String(fields.action||''),lastUpdate:row.at,
  lastResult:kind==='tool'?fields:undefined,
  unfinished:!scope.finished,
 });
}
export function patrolLogObservation({action='',args={},result=null,error='',step=0}={}){
 const scope=storage.getStore();
 if(!isPatrolPeer(scope?.peerId))return;
 traceRow(scope,'tool',{action,step,args,result,error});
}
export function patrolTracePlanner({step=0,response='',question='',context='',notes=[]}={}){
 const scope=storage.getStore();
 if(!isPatrolPeer(scope?.peerId))return;
 traceRow(scope,'planner',{step,question,context:step===0?context:undefined,
  response:String(response).slice(0,160000),
  recentObservations:Array.isArray(notes)?notes.slice(-8):[]});
}
export function patrolTraceStatus(status,details={}){
 const scope=storage.getStore();
 if(!isPatrolPeer(scope?.peerId))return;
 scope.finalStatus=String(status||'completed');
 traceRow(scope,'status',{status:scope.finalStatus,...details});
}

// Native handlers may enqueue a message and return before their VK send happens.
// Accepting a command is not the same thing as failing to generate an answer.
export function markPatrolNativeCommandHandled(kind='native'){
 const scope=storage.getStore();
 if(!isPatrolPeer(scope?.peerId)||scope.adaptive===false)return false;
 scope.nativeCommandHandled=true;
 logPatrolAdaptiveStep({action:'native_command',status:'accepted-async',detail:String(kind).slice(0,60)});
 return true;
}
export function patrolShouldRepairNativeNoOutput(scope=patrolActiveScope()){
 return Boolean(isPatrolPeer(scope?.peerId)&&scope.adaptive!==false
  &&scope.addressed&&scope.delegatedNative&&!(scope.sentCount>0)
  &&!scope.nativeCommandHandled);
}
export function logPatrolAdaptiveStep({action='',status='',step=0,detail=''}={}){
 const scope=storage.getStore();
 if(!isPatrolPeer(scope?.peerId))return;
 log('steps-'+dayParts().day+'.jsonl',{
  at:new Date().toISOString(),peerId:scope.peerId,requestId:scope.requestId,
  action:String(action).slice(0,45),status:String(status).slice(0,65),
  step:Number(step)||0,detail:String(detail).slice(0,500)});
}
export function patrolUsage(day=dayParts().day){
 const list=records('usage-'+day+'.jsonl');
 const stats={day,tokens:0,inputTokens:0,outputTokens:0,calls:list.length,imageCalls:0,visionCalls:0,estimatedCalls:0,limit:PATROL_DAILY_TOKEN_LIMIT};
 for(const row of list){
  stats.tokens+=Math.max(0,Number(row.tokens)||0);stats.inputTokens+=Math.max(0,Number(row.inputTokens)||0);
  stats.outputTokens+=Math.max(0,Number(row.outputTokens)||0);
  if(row.capability==='image')stats.imageCalls++;if(row.capability==='vision')stats.visionCalls++;
  if(row.usageSource!=='provider')stats.estimatedCalls++;
 }
 stats.remaining=Math.max(0,stats.limit-stats.tokens);return stats;
}
export function patrolCanSpend(reserve=500_000){
 const scope=storage.getStore();
 const own=isPatrolPeer(scope?.peerId)&&scope?.adaptive!==false
  ?Math.max(0,Number(scope.dailyReservation)||0):0;
 return patrolUsage().tokens+Math.max(0,reserved-own)+reserve<=PATROL_DAILY_TOKEN_LIMIT;
}
export async function runPatrolScopedRequest(id,handler){
 if(!patrolCanSpend()){
  const stats=patrolUsage();
  log('budget-denials-'+stats.day+'.jsonl',{
   at:new Date().toISOString(),requestId:String(id||''),
   tokensUsed:stats.tokens,dailyLimit:stats.limit,reason:'daily-token-budget'});
  return {allowed:false,reason:'daily-token-budget'};
 }
 const reservation=500_000;
 reserved+=reservation;
 try{return {allowed:true,result:await storage.run({
  peerId:PATROL_PEER_ID,requestId:String(id||''),adaptive:true,
  tokensUsed:0,events:0,dailyReservation:reservation,startedAt:new Date().toISOString()
 },async()=>{
  const scope=storage.getStore();
  traceRow(scope,'request-started',{budget:PATROL_REQUEST_TOKEN_LIMIT});
  try{return await handler()}
  catch(error){scope.finalStatus='failed';
   traceRow(scope,'error',{error:String(error?.message||error).slice(0,400)});
   throw error}
  finally{
   scope.finished=true;
   scope.finalStatus=scope.finalStatus||'completed';
   traceRow(scope,'request-finished',{status:scope.finalStatus,
    elapsedMs:Date.now()-Date.parse(scope.startedAt),
    tokensUsed:scope.tokensUsed,requestLimit:PATROL_REQUEST_TOKEN_LIMIT});
  }
 })}}
 finally{reserved=Math.max(0,reserved-reservation)}
}
export async function runPatrolNormalFallback(id,handler){
 return storage.run({peerId:PATROL_PEER_ID,requestId:String(id||''),adaptive:false},handler);
}
export function disablePatrolAdaptiveForCurrentRequest(){
 const scope=storage.getStore();
 if(isPatrolPeer(scope?.peerId))scope.adaptive=false;
}
export function recordPatrolTokenUsage(row){
 const s=storage.getStore();if(!isPatrolPeer(s?.peerId)||s?.adaptive===false)return;
 const used=Math.max(0,Number(row.totalTokens||row.estimatedTextTokens||0));
 s.tokensUsed=(Number(s.tokensUsed)||0)+used;
 const when=new Date(row.timestamp||Date.now());
 log('usage-'+dayParts(when).day+'.jsonl',{
  at:when.toISOString(),requestId:s.requestId,model:row.model,provider:row.provider,
  capability:row.capability,operation:row.operation,usageSource:row.usageSource,
  tokens:Math.max(0,Number(row.totalTokens||row.estimatedTextTokens||0)),
  inputTokens:Math.max(0,Number(row.inputTokens)||0),outputTokens:Math.max(0,Number(row.outputTokens)||0)});
}
export async function maybeSendPatrolMorningReport(sendToOwner,now=new Date()){
 const current=dayParts(now);
 if(current.minute<9*60)return false;
 const state=load(location('sent-reports.json'),{days:[]});
 if(state.days.includes(current.day))return false;
 const reportDay=yesterday(current.day),startPath=location('tracking-start.json');
 const started=load(startPath,null);
 if(!started)save(startPath,{day:current.day});
 if(reportDay<String(started?.day||current.day))return false;
 const s=patrolUsage(reportDay);
 const requests=records('requests-'+reportDay+'.jsonl').filter(x=>x.addressed).length;
 const message='📊 Адаптивный режим «Воронежский патруль» за '+reportDay+
  '\nОбращений: '+requests+'\nВызовов ИИ: '+s.calls+
  '\nИзрасходовано: '+s.tokens.toLocaleString('ru-RU')+' / '+PATROL_DAILY_TOKEN_LIMIT.toLocaleString('ru-RU')+' токенов'+
  '\nВходные: '+s.inputTokens.toLocaleString('ru-RU')+
  '\nВыходные: '+s.outputTokens.toLocaleString('ru-RU')+
  '\nVision: '+s.visionCalls+'; генерации: '+s.imageCalls+
  (s.estimatedCalls?'\n⚠️ '+s.estimatedCalls+' записей с приблизительным расходом.':'');
 await sendToOwner(message);
 state.days=[...state.days,current.day].slice(-35);save(location('sent-reports.json'),state);return true;
}
export function logPatrolMessage(context,raw,{addressed=false}={}){
 if(!isPatrolPeer(context?.peerId))return;
 const msg=raw?.message||raw||{};
 const attachments=Array.isArray(msg.attachments)?msg.attachments:[];
 const photos=attachments.filter(x=>x?.type==='photo').map(x=>({
  id:Number(x.photo?.id||0),ownerId:Number(x.photo?.owner_id||0),
  url:[...(x.photo?.sizes||[])].sort((a,b)=>Number(b.width||0)*Number(b.height||0)-Number(a.width||0)*Number(a.height||0))[0]?.url||''
 })).filter(x=>x.url);
 const row={at:new Date().toISOString(),cmid:Number(msg.conversation_message_id||context.conversationMessageId||0),
  peerId:Number(context.peerId||0),messageId:Number(msg.id||0),senderId:Number(msg.from_id||context.externalSenderId||context.senderId||0),
  addressed:Boolean(addressed),text:String(msg.text||context.text||'').slice(0,3000),photoCount:photos.length};
 log('requests-'+dayParts().day+'.jsonl',row);
 const scope=storage.getStore();
 if(scope&&isPatrolPeer(scope.peerId))scope.addressed=Boolean(addressed);
 if(photos.length)log('photos-'+dayParts().day+'.jsonl',{...row,photos});
}
export function patrolRecentRequests(max=15){
 const day=dayParts().day;return [...readJsonlTail(location('requests-'+yesterday(day)+'.jsonl'),max),...readJsonlTail(location('requests-'+day+'.jsonl'),max)].slice(-max)
  .map(x=>({cmid:x.cmid,senderId:x.senderId,text:x.text,photos:x.photoCount}));
}
export function patrolRecentPhotoMessages(max=20){
 const day=dayParts().day;return [...readJsonlTail(location('photos-'+yesterday(day)+'.jsonl'),max),...readJsonlTail(location('photos-'+day+'.jsonl'),max)].slice(-max)
  .map(x=>({cmid:x.cmid,senderId:x.senderId,photos:x.photoCount}));
}
export function parsePatrolPersonalPhotoCommand(text){
 const clean=String(text||'').trim().replace(/^(?:гигорейв|gigorave)[,:\s]+/iu,'');
 const m=clean.match(/^(?:личное\s+фото|мо[её]\s+фото|закрепи(?:ть)?\s+(?:фото\s+)?персонажа)(?:\s+(.+))?$/iu);
 return m?{name:String(m[1]||'').trim().slice(0,72)}:null;
}
function photoProfiles(){return load(location('people.json'),{people:[]})}
export function patrolPeople(){return photoProfiles().people.map(p=>({userId:p.userId,name:p.name,photos:p.photos.length}))}
export function savePatrolPersonalPhotos({peerId,userId,name,sourceCmid,sourceMessageId,uploadedBy,dataUrls}){
 if(!isPatrolPeer(peerId))throw new Error('Profile is outside target VK chat');
 const archive=photoProfiles(),label=String(name||'').trim().slice(0,72)||('id'+Number(userId));
 let person=archive.people.find(p=>(Number(userId)>0&&p.userId===Number(userId))||p.name.toLocaleLowerCase('ru')===label.toLocaleLowerCase('ru'));
 if(!person){person={userId:Number(userId)||0,name:label,aliases:[],photos:[]};archive.people.push(person)}
 if(label&&!person.aliases.includes(label))person.aliases.push(label);
 if(label&&!label.startsWith('id'))person.name=label;
 let added=0;
 for(const data of (Array.isArray(dataUrls)?dataUrls:[]).slice(0,4)){
  const m=String(data).match(/^data:image\/(jpeg|png|webp);base64,([a-z0-9+/=]+)$/iu);
  if(!m)continue;
  const bytes=Buffer.from(m[2],'base64');
  if(!bytes.length||bytes.length>6*1024*1024)continue;
  const sha=createHash('sha256').update(bytes).digest('hex');
  if(person.photos.some(p=>p.sha===sha))continue;
  const ext=m[1]==='jpeg'?'jpg':m[1];
  const path=location('people/'+sha+'.'+ext);
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);
  person.photos.unshift({sha,path,sourceCmid:Number(sourceCmid)||0,sourceMessageId:Number(sourceMessageId)||0,
   uploadedBy:Number(uploadedBy)||0,confirmed:true,at:new Date().toISOString()});
  added++;
 }
 person.photos=person.photos.slice(0,20);
 save(location('people.json'),archive);
 return {name:person.name,userId:person.userId,photos:person.photos.length,added,sourceCmid};
}
function matchesName(prompt,name){
 const text=String(prompt||'').toLocaleLowerCase('ru-RU');
 const alias=String(name||'').trim().toLocaleLowerCase('ru-RU');
 if(alias.length<3)return false;
 const key=alias.endsWith('й')?alias.slice(0,-1):alias;
 const safe=key.replace(/[.*+?^$()|{}[\]\\]/gu,'\\$&');
 return new RegExp('(?:^|[^\\p{L}])'+safe+'(?:а|у|ом|ем|е|я|ю|й|ый|ого|ому|ым)?(?=$|[^\\p{L}])','iu').test(text);
}
export function patrolPinnedPhotoReferences(peerId,prompt,max=PATROL_MAX_REFS_PER_PERSON){
 if(!isPatrolPeer(peerId))return [];
 const matches=photoProfiles().people.filter(p=>[p.name,...p.aliases].some(x=>matchesName(prompt,x)));
 const output=[];let totalBytes=0;
 for(const p of matches)for(const img of p.photos.slice(0,PATROL_MAX_REFS_PER_PERSON)){
  if(output.length>=Math.min(max,PATROL_MAX_REFS_TOTAL))return output;
  try{
   const bytes=readFileSync(img.path);if(totalBytes+bytes.length>18*1024*1024)continue;
   const ext=String(img.path).split('.').at(-1);const mime=ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg';
   output.push('data:'+mime+';base64,'+bytes.toString('base64'));totalBytes+=bytes.length;
  }catch{}
 }
 return output;
}
