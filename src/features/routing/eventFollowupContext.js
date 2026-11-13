export const EVENT_FOLLOWUP_TTL_MS=10*60*1000;
const KNOWN_WORDS=new Set('а ну и тогда покажи покажешь покажите какие будут есть тусы тусовки события мероприятия на в во за этих эти этой эту ближних ближайших следующих выходных выходные сегодня завтра неделе неделю неделя месяц месяце месяца только бесплатные бесплатных бесплатно вход свободный гигорейв гигарейв gigorave'.split(' '));
export function parseEventFollowup(text){
 const words=String(text||'').normalize('NFKC').toLowerCase().replace(/ё/gu,'е').replace(/[?!.,:;]+/gu,' ').trim().split(/\s+/u);
 if(!words.length||words.join(' ').length>130||words.some(w=>!KNOWN_WORDS.has(w)))return null;
 const periodPhrase=words.some(w=>w.startsWith('выходн'))?'на выходных':words.includes('сегодня')?'сегодня':words.includes('завтра')?'завтра':words.some(w=>w.startsWith('недел'))?'на неделю':words.some(w=>w.startsWith('месяц'))?'на месяц':'';
 const freeOnly=words.some(w=>w.startsWith('бесплатн'))||(words.includes('свободный')&&words.includes('вход'));
 return periodPhrase||freeOnly?{periodPhrase,freeOnly}:null;
}
export function eventHasConfirmedFreeEntry(event){
 const values=[event?.price,event?.ticketPrice,event?.admissionPrice].filter(x=>x!==undefined&&x!==null&&String(x).trim());
 if(!values.length)return event?.isFree===true;
 const price=values.join(' ').normalize('NFKC').toLowerCase().replace(/ё/gu,'е').trim();
 return /^(?:0+(?:[.,]0+)?\s*(?:₽|р\.?|руб(?:лей|ля)?\.?)?|бесплатно|бесплатный вход|вход бесплатный|вход свободный|свободный вход|free(?: entry| admission)?)\.?$/iu.test(price);
}
export function createEventFollowupStore({now=()=>Date.now(),ttlMs=EVENT_FOLLOWUP_TTL_MS,maxEntries=800}={}){
 const states=new Map();
 const key=c=>{
  const platform=String(c?.platform||'vk');
  const peer=String(c?.externalPeerId||c?.peerId||'');
  const user=String(c?.externalSenderId||c?.senderId||'');
  const thread=platform==='telegram'?String(c?.telegramMessageThreadId||''):'';
  return peer&&user&&user!=='0'?platform+':'+peer+':'+thread+':'+user:'';
 };
 function read(c){
  const k=key(c),v=k?states.get(k):null;
  if(!v)return null;
  if(now()>=v.expiresAt){states.delete(k);return null;}
  return v;
 }
 function remember(c,request){
  const k=key(c),r=request?.range;
  if(!k||!(/^\d{4}-\d{2}-\d{2}$/u.test(r?.fromDate||'')&&/^\d{4}-\d{2}-\d{2}$/u.test(r?.toDate||'')))return false;
  if(states.size>=maxEntries){
   for(const [k,v] of states)if(now()>=v.expiresAt)states.delete(k);
   if(states.size>=maxEntries)states.delete(states.keys().next().value);
  }
  states.set(k,{
   range:{...r},compact:Boolean(request.compact),partyPool:String(request.partyPool||'primary'),
   allParties:Boolean(request.allParties),includeQtickets:Boolean(request.includeQtickets),
   filters:request.filters&&typeof request.filters==='object'?{...request.filters}:null,
   expiresAt:now()+ttlMs,
  });
  return true;
 }
 function match(c,values){
  const state=read(c);if(!state)return null;
  for(const value of Array.isArray(values)?values:[values]){
   const refinement=parseEventFollowup(value);
   if(refinement)return {state,refinement};
  }
  return null;
 }
 return {read,remember,match,forget(c){states.delete(key(c));}};
}
