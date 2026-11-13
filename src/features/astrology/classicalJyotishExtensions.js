/**
 * Deterministic Parashari extensions derived from Swiss sidereal (Lahiri) longitudes.
 * The selected convention is explicit. Alternative lineages can map vargas differently.
 * No GPT is used in any calculation below.
 */
const SIGNS=['Овен','Телец','Близнецы','Рак','Лев','Дева','Весы','Скорпион','Стрелец','Козерог','Водолей','Рыбы'];
export const SHODASHAVARGA_DIVISIONS=Object.freeze([1,2,3,4,7,9,10,12,16,20,24,27,30,40,45,60]);
const NAMES={1:'Раши',2:'Хора',3:'Дреккана',4:'Чатуртхамша',7:'Саптамша',9:'Навамша',10:'Дашамша',12:'Двадашамша',16:'Шодашамша',20:'Вимшамша',24:'Чатурвимшамша',27:'Саптавимшамша',30:'Тримшамша',40:'Кхаведамша',45:'Акшаведамша',60:'Шаштиамша'};
const mod12=x=>((x%12)+12)%12;
const zodiac=x=>((x%360)+360)%360;
const names=['Солнце','Луна','Марс','Меркурий','Юпитер','Венера','Сатурн'];
const ASHTAKAVARGA_RULES=Object.freeze({
 'Солнце':[
  [1,2,4,7,8,9,10,11],[3,6,10,11],[1,2,4,7,8,9,10,11],[3,5,6,9,10,11,12],
  [5,6,9,11],[6,7,12],[1,2,4,7,8,9,10,11],[3,4,6,10,11,12]],
 'Луна':[
  [3,6,7,8,10,11],[1,3,6,7,10,11],[2,3,5,6,9,10,11],[1,3,4,5,7,8,10,11],
  [1,4,7,8,10,11,12],[3,4,5,7,9,10,11],[3,5,6,11],[3,6,10,11]],
 'Марс':[
  [3,5,6,10,11],[3,6,11],[1,2,4,7,8,10,11],[3,5,6,11],
  [6,10,11,12],[6,8,11,12],[1,4,7,8,9,10,11],[1,3,6,10,11]],
 'Меркурий':[
  [5,6,9,11,12],[2,4,6,8,10,11],[1,2,4,7,8,9,10,11],[1,3,5,6,9,10,11,12],
  [6,8,11,12],[1,2,3,4,5,8,9,11],[1,2,4,7,8,9,10,11],[1,2,4,6,8,10,11]],
 'Юпитер':[
  [1,2,3,4,7,8,9,10,11],[2,5,7,9,11],[1,2,4,7,8,10,11],[1,2,4,5,6,9,10,11],
  [1,2,3,4,7,8,10,11],[2,5,6,9,10,11],[3,5,6,12],[1,2,4,5,6,7,9,10,11]],
 'Венера':[
  [8,11,12],[1,2,3,4,5,8,9,11,12],[3,5,6,9,11,12],[3,5,6,9,11],
  [5,8,9,10,11],[1,2,3,4,5,8,9,10,11],[3,4,5,8,9,10,11],[1,2,3,4,5,8,9,11]],
 'Сатурн':[
  [1,2,4,7,8,10,11],[3,6,11],[3,5,6,10,11,12],[6,8,9,10,11,12],
  [5,6,11,12],[6,11,12],[3,5,6,11],[1,3,4,6,10,11]],
});
const expected=[48,49,39,54,56,52,39];
for(let i=0;i<names.length;i++){
 const sum=ASHTAKAVARGA_RULES[names[i]].reduce((n,positions)=>n+positions.length,0);
 if(sum!==expected[i])throw Error('Internal Ashtakavarga rule table is inconsistent for '+names[i]+' total '+sum);
}
function partData(longitude,division){
 if(!Number.isFinite(longitude))throw new TypeError('Varga requires a finite Swiss sidereal longitude');
 const lon=zodiac(longitude),sign=Math.floor(lon/30);
 const deg=lon-sign*30;const odd=(sign%2===0);const type=sign%3;
 const partSize=30/division;
 const part=Math.min(division-1,Math.floor(deg/partSize+1e-12));
 const offset=Math.max(0,deg-part*partSize);
 let to=sign,width=partSize,index=part,within=offset;
 switch(division){
 case 1:to=sign;break;
 case 2:to=odd?(part===0?4:3):(part===0?3:4);break;
 case 3:to=mod12(sign+4*part);break;
 case 4:to=mod12(sign+3*part);break;
 case 7:to=mod12(sign+(odd?0:6)+part);break;
 case 9:to=mod12(sign+[0,8,4][type]+part);break;
 case 10:to=mod12(sign+(odd?0:8)+part);break;
 case 12:to=mod12(sign+part);break;
 case 16:to=mod12([0,4,8][type]+part);break;
 case 20:to=mod12([0,8,4][type]+part);break;
 case 24:to=mod12((odd?4:3)+part);break;
 case 27:to=mod12([0,3,6,9][sign%4]+part);break;
 case 30:{
  // Parashari unequal five-band Trimsamsa, not 30 equal longitude harmonics.
  const sizes=odd?[5,5,8,7,5]:[5,7,8,5,5];
  const signs=odd?[0,10,8,2,6]:[1,5,11,9,7];
  let start=0;for(let i=0;i<5;i++){if(deg<start+sizes[i] || i===4){
   index=i;within=deg-start;width=sizes[i];to=signs[i];break;
  }start+=sizes[i];}
  break;
 }
 case 40:to=mod12((odd?0:6)+part);break;
 case 45:to=mod12([0,4,8][type]+part);break;
 case 60:to=mod12(sign+part);break;
 default:throw new RangeError('Unsupported traditional Parashari varga D'+division);
 }
 return {division,signIndex:to,sign:SIGNS[to],partIndex:index+1,
  portionDegrees:width,degreesInsidePortion:within,
  mappedDegreesInSign:within/width*30,
  natalSignIndex:sign,natalDegreesInsideSign:deg};
}
export function calculateTraditionalVargaPosition(longitude,division){
 if(!SHODASHAVARGA_DIVISIONS.includes(division))throw new RangeError('Unsupported classical varga D'+division);
 return partData(longitude,division);
}
function pointsOf(ascendant,bodies){
 const points=[{name:'Лагна',longitude:ascendant}];
 for(const body of bodies||[])if(Number.isFinite(body?.sidereal?.longitudeDegrees))
  points.push({name:body.name,longitude:body.sidereal.longitudeDegrees});
 return points;
}
export function calculateClassicalDivisionalCharts({ascendant,bodies=[],ascendantSpeedDegreesPerDay=null}={}){
 const points=pointsOf(ascendant,bodies);
 const result={};
 for(const n of SHODASHAVARGA_DIVISIONS){
  const entries=points.map(point=>{
   const pos=partData(point.longitude,n);
   return {name:point.name,signIndex:pos.signIndex,sign:pos.sign,
    partIndex:pos.partIndex,portionDegrees:pos.portionDegrees,
    degreesInsidePortion:pos.degreesInsidePortion,
    mappedDegreesInSign:pos.mappedDegreesInSign,
    natalLongitudeDegrees:zodiac(point.longitude)};
  });
  const lagna=entries[0];
  for(const item of entries)item.houseFromVargaLagna=mod12(item.signIndex-lagna.signIndex)+1;
  const speed=Math.abs(Number(ascendantSpeedDegreesPerDay));
  const lagnaLongitude=zodiac(ascendant)%30;
  const currentPart=partData(ascendant,n);
  const distance=Math.min(currentPart.degreesInsidePortion,
   currentPart.portionDegrees-currentPart.degreesInsidePortion);
  const lagnaBoundaryMinutesEstimate=Number.isFinite(speed)&&speed>0.00001
   ?Math.round(distance/speed*1440*100)/100:null;
  result['D'+n]={division:n,name:NAMES[n],method:'Parashari selected convention',
   lagnaSignIndex:lagna.signIndex,lagnaSign:lagna.sign,points:entries,
   lagnaBoundaryMinutesEstimate,
   note:n===30?'Unequal five-sector Trimsamsa.':null};
 }
 const d1=new Map(result.D1.points.map(p=>[p.name,p.signIndex]));
 const d9=result.D9.points;
 result.D9.vargottama=d9.filter(p=>d1.get(p.name)===p.signIndex).map(p=>p.name);
 return result;
}
export function calculateAshtakavarga({ascendant,bodies=[]}={}){
 const points=pointsOf(ascendant,bodies);
 const byName=new Map(points.map(x=>[x.name,Math.floor(zodiac(x.longitude)/30)]));
 const missing=names.filter(name=>!byName.has(name));
 if(missing.length)throw new Error('Cannot calculate 337-bindu Ashtakavarga: missing '+missing.join(', '));
 const refs=names.concat('Лагна'),bhinna={},sarva=Array(12).fill(0);
 for(let i=0;i<names.length;i++){
  const planet=names[i],bindus=Array(12).fill(0),contributions={};
  for(let j=0;j<refs.length;j++){
   const contributor=refs[j],sign=byName.get(contributor),houses=ASHTAKAVARGA_RULES[planet][j];
   const marked=houses.map(house=>mod12(sign+house-1));
   contributions[contributor]=marked;
   for(const index of marked)bindus[index]++;
  }
  const total=bindus.reduce((n,x)=>n+x,0);
  if(total!==expected[i])throw Error('BAV sum invalid for '+planet+': '+total);
  bhinna[planet]={bindus,total,contributors:contributions};
  for(let sign=0;sign<12;sign++)sarva[sign]+=bindus[sign];
 }
 const total=sarva.reduce((n,x)=>n+x,0);
 if(total!==337)throw Error('Sarvashtakavarga sum invalid: '+total);
 return {method:'Unreduced classical BAV/SAV eight-contributor scheme',
  signs:SIGNS,bhinna,sarva,total,
  lagnaSignIndex:byName.get('Лагна'),
  houseBindusFromLagna:Array.from({length:12},(_,i)=>sarva[mod12(byName.get('Лагна')+i)]),
  includesTrikonaShodhana:false,includesEkadhipatyaShodhana:false,
  limitations:'Raw 337 bindu BAV/SAV; no Trikona/Ekadhipatya purification or Shodhya Pinda.'};
}
export function calculateReferenceHouseCharts({ascendant,bodies=[],arudhaSignIndex=null}={}){
 const points=pointsOf(ascendant,bodies);
 const byName=new Map(points.map(p=>[p.name,Math.floor(zodiac(p.longitude)/30)]));
 const definitions=[['lagna','Лагна'],['chandra','Луна'],['surya','Солнце']];
 if(Number.isSafeInteger(arudhaSignIndex)&&arudhaSignIndex>=0&&arudhaSignIndex<12)
  definitions.push(['arudha','Арудха-лагна']);
 return Object.fromEntries(definitions.flatMap(([key,ref])=>{
  const base=ref==='Арудха-лагна'?arudhaSignIndex:byName.get(ref);
  if(!Number.isInteger(base))return [];
  return [[key,{reference:ref,referenceSign:SIGNS[base],referenceSignIndex:base,
   planets:points.map(p=>({name:p.name,signIndex:byName.get(p.name),
    sign:SIGNS[byName.get(p.name)],house:mod12(byName.get(p.name)-base)+1}))}]];
 }));
}
const LORDS=['Кету','Венера','Солнце','Луна','Марс','Раху','Юпитер','Сатурн','Меркурий'];
const YEARS=[7,20,6,10,7,18,16,19,17];
function subPeriods(parent,referenceTime){
 const start=Date.parse(parent?.startUtcIso),end=Date.parse(parent?.endUtcIso);
 const index=LORDS.indexOf(parent?.lord);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||index<0)return [];
 let cursor=start;
 return Array.from({length:9},(_,i)=>{
  const j=(index+i)%9;
  const next=i===8?end:cursor+(end-start)*YEARS[j]/120;
  const v={lord:LORDS[j],startUtcIso:new Date(cursor).toISOString(),
   endUtcIso:new Date(next).toISOString(),activeAtReference:referenceTime>=cursor&&referenceTime<next};
  cursor=next;return v;
 });
}
export function calculateActiveVimshottariMicroPeriods(dasha,referenceDate){
 if(!dasha?.activePratyantardasha)return null;
 const at=referenceDate instanceof Date?referenceDate.getTime():Date.parse(referenceDate);
 if(!Number.isFinite(at))return null;
 const sookshma=subPeriods(dasha.activePratyantardasha,at);
 const active=sookshma.find(p=>p.activeAtReference);
 const prana=active?subPeriods(active,at):[];
 return {sookshmaPeriods:sookshma,pranaPeriods:prana,
  activeSookshma:active?{...active}:null,
  activePrana:prana.find(p=>p.activeAtReference)??null,
  note:'Only microperiods inside active Pratyantardasha; mean tropical-year Vimshottari clock, not astronomical causation.'};
}
export function calculatePartialNaturalBala({bodies=[]}={}){
 const natural={Солнце:60,Луна:60*6/7,Венера:60*5/7,Юпитер:60*4/7,
  Меркурий:60*3/7,Марс:60*2/7,Сатурн:60/7};
 const available=new Set((bodies||[]).map(x=>x.name));
 return {method:'Naisargika Bala (natural strength), one of six Shadbala components',
  unit:'virupa',values:Object.fromEntries(Object.entries(natural)
  .filter(([name])=>available.has(name)).map(([name,value])=>[name,Math.round(value*10000)/10000])),
  completeShadbala:false,missing:['Sthana Bala','Dig Bala','Kala Bala','Cheshta Bala','Drik Bala'],
  note:'Do not report a Shadbala total or strength verdict from this partial calculation.'};
}
