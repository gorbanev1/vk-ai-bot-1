const FORMS=new Map(Object.entries({
'дизеле':'дизель','дизеля':'дизель','дизил':'дизель','дизиле':'дизель',
'тупике':'тупик','ливерпуле':'ливерпуль','балагане':'балаган',
'винзаводе':'винзавод','котельной':'котельная','маме':'мама',
'анархии':'анархия','холле':'холл','баре':'бар',
'пинте':'пинта','литере':'литера','чайке':'чайка','башне':'башня',
'малине':'малина','клубе':'клуб','пабе':'паб'
}));
const GENERIC=new Set('в во на бар рок клуб паб холл hall bar rock pub club venue площадка зал центр арт art the of last ул улица кафе cafe ресторан рестобар театр'.split(' '));
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/ё/gu,'е').replace(/[«»„“”"']/gu,' ').replace(/[^a-zа-я0-9]+/giu,' ').replace(/\s+/gu,' ').trim();
const tokens=(s,all=false)=>norm(s).split(' ').map(t=>FORMS.get(t)||t).filter(t=>t.length>=3&&!/^\d+$/u.test(t)&&(all||!GENERIC.has(t)));
const stem=t=>t.replace(/(?:ого|его|ому|ему|ыми|ими|ом|ем|ой|ый|ий|ая|ое|ые|ам|ах|ях|ов|ев|ей|ы|и|е|а|я|ь)$/u,'');
export function extractEventVenueAfterIn(s){
 const text=norm(s);
 if(!/^(?:тус(?:а|ы|овка|овки)|событи(?:е|я)|мероприяти(?:е|я))(?:\s|$)/u.test(text))return '';
 const m=text.match(/(?:^|\s)(?:в|во)\s+([a-zа-я0-9][^\n]{0,90})/u);
 if(!m)return '';
 const part=m[1].split(/\s+(?=(?:\d{1,2}(?:\s|$)|подробно|кратко|сегодня|завтра|послезавтра|на\s+выходных|на\s+недел|на\s+месяц|следующ|ближайш|этот|эти))/u)[0].trim();
 return part.length>=3?part:'';
}
export function matchEventVenueCatalog(s,items=[]){
 const all=tokens(s,true),wanted=new Set(tokens(s).map(stem));
 if(all.includes('diesel')||all.includes('дизель')){
  if(all.some(t=>['hall','холл','хол'].includes(t)))return ['diesel-hall'];
  if(all.some(t=>['bar','бар','рокбар','rockbar'].includes(t)))return ['diesel-bar'];
  return ['diesel'];
 }
 let best=0,keys=[];
 for(const item of items){
  if(item.key.startsWith('diesel'))continue;
  let score=0;
  for(const alias of item.aliases||[]){
   const reference=tokens(alias).map(stem);
   if(!reference.length)continue;
   const count=reference.filter(t=>wanted.has(t)).length;
   if(count)score=Math.max(score,count*100+(count===reference.length?30:0)+(count===wanted.size?20:0));
  }
  if(score>best){best=score;keys=[item.key];}
  else if(score>0&&score===best)keys.push(item.key);
 }
 return keys.length===1?keys:[];
}
export function selectEventsByBestVenueMatch(events,phrase){
 const query=[...new Set(tokens(phrase).map(stem))];if(!query.length)return [];
 let top=-1,groups=new Map();
 for(const e of Array.isArray(events)?events:[]){
  const venue=String(e?.venue||'').split(',')[0];
  const vt=[...new Set(tokens(venue).map(stem))];
  const matched=query.filter(x=>vt.includes(x)).length;
  if(!matched)continue;
  const score=matched*100+(matched===query.length?40:0)-Math.max(0,vt.length-matched);
  const group=String(e?.venueKey||'').trim()||tokens(venue).join('-');
  if(score>top){top=score;groups=new Map();}
  if(score===top){const list=groups.get(group)||[];list.push(e);groups.set(group,list);}
 }
 return top>=100&&groups.size===1?[...groups.values()][0]:[];
}
