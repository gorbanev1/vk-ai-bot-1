import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const MAX_JOBS=10,MIN_MS=1000,MAX_MS=7*86400000;
const numberWords=Object.freeze({"\u043e\u0434\u0438\u043d":1,"\u043e\u0434\u043d\u0443":1,"\u043e\u0434\u043d\u0430":1,"\u043e\u0434\u043d\u043e":1,"\u0434\u0432\u0430":2,"\u0434\u0432\u0435":2,"\u0442\u0440\u0438":3,"\u0447\u0435\u0442\u044b\u0440\u0435":4,"\u043f\u044f\u0442\u044c":5,"\u0448\u0435\u0441\u0442\u044c":6,"\u0441\u0435\u043c\u044c":7,"\u0432\u043e\u0441\u0435\u043c\u044c":8,"\u0434\u0435\u0432\u044f\u0442\u044c":9,"\u0434\u0435\u0441\u044f\u0442\u044c":10,"\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u044c":20,"\u0442\u0440\u0438\u0434\u0446\u0430\u0442\u044c":30,"\u0441\u043e\u0440\u043e\u043a":40,"\u043f\u044f\u0442\u044c\u0434\u0435\u0441\u044f\u0442":50,"\u0448\u0435\u0441\u0442\u044c\u0434\u0435\u0441\u044f\u0442":60});
const parseAmount=value=>{
 const raw=String(value||'').trim().toLowerCase();
 return Object.hasOwn(numberWords,raw)?numberWords[raw]:Number(raw.replace(',','.'));
};
const unitFactors=Object.freeze({"\u0441\u0435\u043a\u0443\u043d\u0434":1000,"\u0441\u0435\u043a\u0443\u043d\u0434\u0430":1000,"\u0441\u0435\u043a\u0443\u043d\u0434\u0443":1000,"\u0441\u0435\u043a\u0443\u043d\u0434\u044b":1000,"\u0441\u0435\u043a\u0443\u043d\u0434\u0435":1000,"\u0441\u0435\u043a\u0443\u043d\u0434\u043e\u0439":1000,"\u0441\u0435\u043a":1000,"\u0441":1000,"\u043c\u0438\u043d\u0443\u0442":60000,"\u043c\u0438\u043d\u0443\u0442\u0430":60000,"\u043c\u0438\u043d\u0443\u0442\u0443":60000,"\u043c\u0438\u043d\u0443\u0442\u044b":60000,"\u043c\u0438\u043d\u0443\u0442\u0435":60000,"\u043c\u0438\u043d\u0443\u0442\u043e\u0439":60000,"\u043c\u0438\u043d":60000,"\u043c":60000,"\u0447\u0430\u0441":3600000,"\u0447\u0430\u0441\u0430":3600000,"\u0447\u0430\u0441\u043e\u0432":3600000,"\u0447":3600000,"\u0434\u0435\u043d\u044c":86400000,"\u0434\u043d\u044f":86400000,"\u0434\u043d\u0435\u0439":86400000,"\u0441\u0443\u0442\u043a\u0438":86400000,"\u0441\u0443\u0442\u043e\u043a":86400000,"\u043d\u0435\u0434\u0435\u043b\u044f":604800000,"\u043d\u0435\u0434\u0435\u043b\u044e":604800000,"\u043d\u0435\u0434\u0435\u043b\u0438":604800000,"\u043d\u0435\u0434\u0435\u043b\u044c":604800000});
const unit=word=>unitFactors[String(word||'').toLowerCase()]||0;
const duration=/(?:\u043a\u0430\u0436\u0434\u044b\u0435|\u043a\u0430\u0436\u0434\u044b\u0439|\u043a\u0430\u0436\u0434\u0443\u044e|\u043a\u0430\u0436\u0434\u043e\u0433\u043e|\u043a\u0430\u0436\u0434\u043e\u0435|\u0440\u0430\u0437\s+\u0432)\s*((?:\d+(?:[.,]\d+)?|\u043e\u0434\u0438\u043d|\u043e\u0434\u043d\u0443|\u043e\u0434\u043d\u0430|\u043e\u0434\u043d\u043e|\u0434\u0432\u0430|\u0434\u0432\u0435|\u0442\u0440\u0438|\u0447\u0435\u0442\u044b\u0440\u0435|\u043f\u044f\u0442\u044c|\u0448\u0435\u0441\u0442\u044c|\u0441\u0435\u043c\u044c|\u0432\u043e\u0441\u0435\u043c\u044c|\u0434\u0435\u0432\u044f\u0442\u044c|\u0434\u0435\u0441\u044f\u0442\u044c|\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u044c|\u0442\u0440\u0438\u0434\u0446\u0430\u0442\u044c|\u0441\u043e\u0440\u043e\u043a|\u043f\u044f\u0442\u044c\u0434\u0435\u0441\u044f\u0442|\u0448\u0435\u0441\u0442\u044c\u0434\u0435\u0441\u044f\u0442))?\s*((?:\u0441\u0435\u043a\u0443\u043d\u0434\u043e\u0439|\u0441\u0435\u043a\u0443\u043d\u0434\u0430|\u0441\u0435\u043a\u0443\u043d\u0434\u0443|\u0441\u0435\u043a\u0443\u043d\u0434\u044b|\u0441\u0435\u043a\u0443\u043d\u0434\u0435|\u043c\u0438\u043d\u0443\u0442\u043e\u0439|\u0441\u0435\u043a\u0443\u043d\u0434|\u043c\u0438\u043d\u0443\u0442\u0430|\u043c\u0438\u043d\u0443\u0442\u0443|\u043c\u0438\u043d\u0443\u0442\u044b|\u043c\u0438\u043d\u0443\u0442\u0435|\u043d\u0435\u0434\u0435\u043b\u044f|\u043d\u0435\u0434\u0435\u043b\u044e|\u043d\u0435\u0434\u0435\u043b\u0438|\u043d\u0435\u0434\u0435\u043b\u044c|\u043c\u0438\u043d\u0443\u0442|\u0447\u0430\u0441\u043e\u0432|\u0441\u0443\u0442\u043a\u0438|\u0441\u0443\u0442\u043e\u043a|\u0447\u0430\u0441\u0430|\u0434\u0435\u043d\u044c|\u0434\u043d\u0435\u0439|\u0441\u0435\u043a|\u043c\u0438\u043d|\u0447\u0430\u0441|\u0434\u043d\u044f|\u0441|\u043c|\u0447))(?!\p{L})(?:\s+(?:\u0438\s+)?((?:\d+(?:[.,]\d+)?|\u043e\u0434\u0438\u043d|\u043e\u0434\u043d\u0443|\u043e\u0434\u043d\u0430|\u043e\u0434\u043d\u043e|\u0434\u0432\u0430|\u0434\u0432\u0435|\u0442\u0440\u0438|\u0447\u0435\u0442\u044b\u0440\u0435|\u043f\u044f\u0442\u044c|\u0448\u0435\u0441\u0442\u044c|\u0441\u0435\u043c\u044c|\u0432\u043e\u0441\u0435\u043c\u044c|\u0434\u0435\u0432\u044f\u0442\u044c|\u0434\u0435\u0441\u044f\u0442\u044c|\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u044c|\u0442\u0440\u0438\u0434\u0446\u0430\u0442\u044c|\u0441\u043e\u0440\u043e\u043a|\u043f\u044f\u0442\u044c\u0434\u0435\u0441\u044f\u0442|\u0448\u0435\u0441\u0442\u044c\u0434\u0435\u0441\u044f\u0442))\s*((?:\u0441\u0435\u043a\u0443\u043d\u0434\u043e\u0439|\u0441\u0435\u043a\u0443\u043d\u0434\u0430|\u0441\u0435\u043a\u0443\u043d\u0434\u0443|\u0441\u0435\u043a\u0443\u043d\u0434\u044b|\u0441\u0435\u043a\u0443\u043d\u0434\u0435|\u043c\u0438\u043d\u0443\u0442\u043e\u0439|\u0441\u0435\u043a\u0443\u043d\u0434|\u043c\u0438\u043d\u0443\u0442\u0430|\u043c\u0438\u043d\u0443\u0442\u0443|\u043c\u0438\u043d\u0443\u0442\u044b|\u043c\u0438\u043d\u0443\u0442\u0435|\u043d\u0435\u0434\u0435\u043b\u044f|\u043d\u0435\u0434\u0435\u043b\u044e|\u043d\u0435\u0434\u0435\u043b\u0438|\u043d\u0435\u0434\u0435\u043b\u044c|\u043c\u0438\u043d\u0443\u0442|\u0447\u0430\u0441\u043e\u0432|\u0441\u0443\u0442\u043a\u0438|\u0441\u0443\u0442\u043e\u043a|\u0447\u0430\u0441\u0430|\u0434\u0435\u043d\u044c|\u0434\u043d\u0435\u0439|\u0441\u0435\u043a|\u043c\u0438\u043d|\u0447\u0430\u0441|\u0434\u043d\u044f|\u0441|\u043c|\u0447))(?!\p{L}))?/iu;
const fractionHour=/(?:\u043e\u0434\u043d\u0430|\u043e\u0434\u043d\u0443)?\s*\u0442\u0440\u0435\u0442\u044c\s+\u0447\u0430\u0441\u0430/giu;
const normalize=s=>String(s??'').normalize('NFKC').replace(/ё/giu,'е').replace(/[«»“”„"'`]/gu,'').replace(/\s+/gu,' ').trim().replace(/^(?:гигорейв|гигарейв|gigorave)(?:[\s,.:;!?\-]+|$)/iu,'').trim();
export function parseRecurringChatWriteCommand(value){
 const original=normalize(value).replace(fractionHour,'0.333333333333 '+String.fromCharCode(1095,1072,1089,1072));
 if(!/(?:^|[^\p{L}])пиши(?:$|[^\p{L}])/iu.test(original))return null;
 const compact=original.toLowerCase().replace(/[?!.,:;#]+/gu,' ').replace(/\s+/gu,' ').trim();
 const words=compact.split(' '),has=x=>words.includes(x);
 if(has('все')&&['отменить','отмени','отмена','удали','стоп','не'].some(has))return {action:'cancel-all'};
 if(['активные','активных','список'].some(has)&&!['отмени','отменить','удали','стоп'].some(has))return {action:'list'};
 const cancel=compact.match(/^(?:(?:не\s+пиши|пиши\s+не|пиши\s+отмени|пиши\s+отменить|отмени\s+пиши|отменить\s+пиши|удали\s+пиши)\s+)(\d{1,3})$/iu);
 if(cancel)return {action:'cancel-one',index:Number(cancel[1])};
 const match=duration.exec(original);if(!match)return {action:'help'};
 const ms=Math.round(parseAmount(match[1]||'1')*unit(match[2])+(match[3]?parseAmount(match[3])*unit(match[4]):0));
 const remainder=(original.slice(0,match.index)+' '+original.slice(match.index+match[0].length))
   .replace(/(?:^|[^\p{L}])пиши(?:$|[^\p{L}])/iu,' ')
   .replace(/(?:^|\s)(?:в\s+(?:чат|беседу|эту\s+беседу)|сюда|здесь)(?=\s|$)/giu,' ')
   .replace(/\s+/gu,' ').replace(/^[\s\-–—:;.,!?]+|[\s\-–—:;.,!?]+$/gu,'').trim();
 if(!Number.isFinite(ms)||ms<MIN_MS||ms>MAX_MS)return {action:'invalid',reason:'interval'};
 if(!remainder||remainder.length>220||/(?:@all|@everyone|@online|@here|https?:\/\/)/iu.test(remainder))return {action:'invalid',reason:'text'};
 return {action:'create',message:remainder,intervalMs:ms};
}
export function formatRecurringInterval(ms){
 let rest=Math.round(Number(ms)/1000);
 if(!Number.isFinite(rest)||rest<1)return '0 сек';
 const days=Math.floor(rest/86400);rest%=86400;
 const hours=Math.floor(rest/3600);rest%=3600;
 const minutes=Math.floor(rest/60),seconds=rest%60;
 return [days?days+' дн.':'',hours?hours+' ч':'',
  minutes?minutes+' мин':'',seconds?seconds+' сек':'']
  .filter(Boolean).join(' ');
}
export function recurringChatWriteHelp(){
 return ['⏰ Команды «пиши»:',
 'Гигорейв, пиши ферма каждые 4,5 часа',
  "\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u0443\u044e \u0441\u0435\u043a\u0443\u043d\u0434\u0443",
  "\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 \u0442\u0440\u0438 \u0441\u0435\u043a\u0443\u043d\u0434\u044b",
  "\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u043f\u0438\u0448\u0438 \u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u0436\u0434\u044b\u0435 \u043f\u044f\u0442\u044c \u043c\u0438\u043d\u0443\u0442",
 'Гигорейв, каждые 4 часа 30 минут пиши ферма',
 'Гигорейв, пиши все активные',
 'Гигорейв, не пиши 1',
 'Гигорейв, пиши отменить все',
 '«В чат» необязательно. Интервал от 1 секунды до 7 дней, до 10 задач на беседу.'].join('\n');
}
function scopeOf(raw){
 const platform=String(raw?.platform||'').toLowerCase();
 const peerId=String(raw?.peerId||''),senderId=String(raw?.senderId||'');
 const threadId=platform==='telegram'?String(raw?.threadId||'0'):'0';
 return ['vk','telegram'].includes(platform)&&peerId&&senderId
   ?{platform,peerId,senderId,threadId,endpointKey:String(raw?.endpointKey||'')}:null;
}
export function createRecurringChatWriteService({databasePath,now=()=>Date.now(),send,maxJobs=MAX_JOBS,log=console,allowedCreators=null}={}){
 if(!databasePath||typeof send!=='function')throw Error('Recurring chat writes require durable path and sender');
 mkdirSync(dirname(databasePath),{recursive:true});
 const db=new DatabaseSync(databasePath);db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000;');
 db.exec([
 'CREATE TABLE IF NOT EXISTS recurring_chat_writes(',
 'id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT NOT NULL,peer_id TEXT NOT NULL,thread_id TEXT NOT NULL DEFAULT \'0\',',
 'creator_id TEXT NOT NULL,endpoint_key TEXT NOT NULL DEFAULT \'\',message_text TEXT NOT NULL,interval_ms INTEGER NOT NULL,',
 'created_at INTEGER NOT NULL,next_at INTEGER NOT NULL,last_sent_at INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,',
 'last_error TEXT NOT NULL DEFAULT \'\',failures INTEGER NOT NULL DEFAULT 0,claim_token TEXT NOT NULL DEFAULT \'\',claimed_until INTEGER NOT NULL DEFAULT 0);',
 'CREATE INDEX IF NOT EXISTS recurring_chat_due_idx ON recurring_chat_writes(active,next_at,claimed_until);',
 'CREATE INDEX IF NOT EXISTS recurring_chat_scope_idx ON recurring_chat_writes(platform,peer_id,thread_id,active,id);'
 ].join('\n'));
 // In production, restrict authority by platform and the authenticated sender,
 // never by text generated by Luna or by a nickname from chat content.
 const permitted=allowedCreators&&typeof allowedCreators==='object'
   ?{vk:String(allowedCreators.vk||''),telegram:String(allowedCreators.telegram||'')}
   :null;
 const authorized=(platform,senderId)=>!permitted||(
   Boolean(permitted[String(platform||'').toLowerCase()])&&
   String(senderId||'')===permitted[String(platform||'').toLowerCase()]);
 const ownerGuard=raw=>{
   const scope=scopeOf(raw);
   return Boolean(scope&&authorized(scope.platform,scope.senderId));
 };
 const disableUnauthorizedQ=db.prepare(
   "UPDATE recurring_chat_writes SET active=0,claim_token='',claimed_until=0 "+
   "WHERE active=1 AND ((platform='vk' AND creator_id<>?) "+
   "OR (platform='telegram' AND creator_id<>?) "+
   "OR platform NOT IN ('vk','telegram'))");
 const disableOneQ=db.prepare(
   "UPDATE recurring_chat_writes SET active=0,claim_token='',claimed_until=0 WHERE id=? AND active=1");
 const cancelledUnauthorized=permitted
   ?Number(disableUnauthorizedQ.run(permitted.vk,permitted.telegram).changes):0;
 if(cancelledUnauthorized)log.warn?.('[RECURRING CHAT WRITE NONOWNER CANCELLED]',
   'count='+cancelledUnauthorized);
 const listQ=db.prepare('SELECT * FROM recurring_chat_writes WHERE platform=? AND peer_id=? AND thread_id=? AND active=1 ORDER BY id');
 const insertQ=db.prepare('INSERT INTO recurring_chat_writes(platform,peer_id,thread_id,creator_id,endpoint_key,message_text,interval_ms,created_at,next_at) VALUES(?,?,?,?,?,?,?,?,?)');
 const cancelQ=db.prepare('UPDATE recurring_chat_writes SET active=0,claim_token=\'\',claimed_until=0 WHERE id=? AND platform=? AND peer_id=? AND thread_id=? AND active=1');
 const cancelAllQ=db.prepare('UPDATE recurring_chat_writes SET active=0,claim_token=\'\',claimed_until=0 WHERE platform=? AND peer_id=? AND thread_id=? AND active=1');
 const candidatesQ=db.prepare('SELECT * FROM recurring_chat_writes WHERE active=1 AND next_at<=? AND claimed_until<=? ORDER BY next_at,id LIMIT 10');
 const claimQ=db.prepare('UPDATE recurring_chat_writes SET claim_token=?,claimed_until=? WHERE id=? AND active=1 AND next_at<=? AND claimed_until<=?');
 const checkQ=db.prepare('SELECT active,claim_token FROM recurring_chat_writes WHERE id=?');
 const successQ=db.prepare('UPDATE recurring_chat_writes SET next_at=?,last_sent_at=?,failures=0,last_error=\'\',claim_token=\'\',claimed_until=0 WHERE id=? AND active=1 AND claim_token=?');
 const failureQ=db.prepare('UPDATE recurring_chat_writes SET next_at=?,failures=failures+1,last_error=?,claim_token=\'\',claimed_until=0 WHERE id=? AND active=1 AND claim_token=?');
 let running=false,closed=false;
 function list(raw){const s=scopeOf(raw);return s&&ownerGuard(raw)?listQ.all(s.platform,s.peerId,s.threadId):[];}
 function create(raw,command){
  const s=scopeOf(raw);if(!s||command?.action!=='create')return {error:'invalid'};
  if(!ownerGuard(raw))return {error:'forbidden'};
  const old=list(s);
  const existing=old.find(x=>x.message_text===command.message&&x.interval_ms===command.intervalMs);
  if(existing)return {existing:true,index:old.indexOf(existing)+1,item:existing};
  if(old.length>=maxJobs)return {error:'limit'};
  const at=now(),res=insertQ.run(s.platform,s.peerId,s.threadId,s.senderId,s.endpointKey,command.message,command.intervalMs,at,at+command.intervalMs);
  const items=list(s),item=items.find(x=>x.id===Number(res.lastInsertRowid));
  return {created:true,index:items.indexOf(item)+1,item};
 }
 function cancelOne(raw,index){
  if(!ownerGuard(raw))return null;
  const s=scopeOf(raw),items=s?list(s):[],i=Number(index);
  if(!Number.isSafeInteger(i)||i<1||i>items.length)return null;
  const item=items[i-1];
  return cancelQ.run(item.id,s.platform,s.peerId,s.threadId).changes?item:null;
 }
 function cancelAll(raw){const s=scopeOf(raw);return s&&ownerGuard(raw)?Number(cancelAllQ.run(s.platform,s.peerId,s.threadId).changes):0;}
 function formatList(raw){
  const items=list(raw);
  if(!items.length)return '⏰ Активных команд «пиши» в этом чате нет.';
  const lines=['⏰ Активные команды «пиши»:'];
  for(const [i,x]of items.entries()){
   const next=new Date(x.next_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',second:'2-digit',day:'2-digit',month:'2-digit'});
   lines.push((i+1)+'. «'+x.message_text+'» — каждые '+formatRecurringInterval(x.interval_ms)+'. Следующее: '+next+' МСК.');
  }
  lines.push('Отмена: «Гигорейв, не пиши 1» или «Гигорейв, пиши отменить все».');
  return lines.join('\n');
 }
 async function tick(){
  if(closed||running)return {skipped:true};
  running=true;let sent=0,failed=0;
  try{
   for(const item of candidatesQ.all(now(),now())){
     if(!authorized(item.platform,item.creator_id)){
      disableOneQ.run(item.id);continue;
     }
    const token=randomUUID(),at=now(),claimed=claimQ.run(token,at+180000,item.id,at,at);
    if(!claimed.changes)continue;
    const current=checkQ.get(item.id);
    if(!current?.active||current.claim_token!==token)continue;
    try{
     await send({id:item.id,platform:item.platform,peerId:item.peer_id,threadId:item.thread_id,endpointKey:item.endpoint_key,text:item.message_text});
     const done=now();successQ.run(done+item.interval_ms,done,item.id,token);sent++;
    }catch(error){
     const msg=String(error?.message||error).slice(0,240);
     failureQ.run(now()+Math.max(10000,Math.min(300000,item.interval_ms)),msg,item.id,token);
     log.warn?.('[RECURRING CHAT WRITE SEND ERROR]',item.platform,item.peer_id,item.id,msg);failed++;
    }
   }
   return {sent,failed};
  }finally{running=false;}
 }
 return {list,create,cancelOne,cancelAll,formatList,tick,cancelledUnauthorized,close(){closed=true;db.close();}};
}
