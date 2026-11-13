/**
 * Additional deterministic traditional-chart measurements.
 * These are school-specific rules, not empirical forecasts; Shadbala remains
 * explicitly partial until Kala, Cheshta and Drik are calculated completely.
 */
const ZODIAC=['Овен','Телец','Близнецы','Рак','Лев','Дева','Весы','Скорпион','Стрелец','Козерог','Водолей','Рыбы'];
const CLASSICAL=['Солнце','Луна','Марс','Меркурий','Юпитер','Венера','Сатурн'];
const LORDS=['Марс','Венера','Меркурий','Луна','Солнце','Меркурий','Венера','Марс','Юпитер','Сатурн','Сатурн','Юпитер'];
const EXALT={Солнце:10,Луна:33,Марс:298,Меркурий:165,Юпитер:95,Венера:357,Сатурн:200};
const NATURAL={Солнце:60,Луна:360/7,Венера:300/7,Юпитер:240/7,Меркурий:180/7,Марс:120/7,Сатурн:60/7};
const OWN={
 Солнце:[4],Луна:[3],Марс:[0,7],Меркурий:[2,5],
 Юпитер:[8,11],Венера:[1,6],Сатурн:[9,10]
};
const FRIEND={
 Солнце:['Луна','Марс','Юпитер'],Луна:['Солнце','Меркурий'],
 Марс:['Солнце','Луна','Юпитер'],Меркурий:['Солнце','Венера'],
 Юпитер:['Солнце','Луна','Марс'],Венера:['Меркурий','Сатурн'],
 Сатурн:['Меркурий','Венера']
};
const ENEMY={
 Солнце:['Венера','Сатурн'],Луна:[],Марс:['Меркурий'],
 Меркурий:['Луна'],Юпитер:['Меркурий','Венера'],
 Венера:['Солнце','Луна'],Сатурн:['Солнце','Луна','Марс']
};
export const VIMSHOPAKA_16_WEIGHTS=Object.freeze({
 1:3.5,2:1,3:1,4:0.5,7:0.5,9:3,10:0.5,12:0.5,
 16:2,20:0.5,24:0.5,27:0.5,30:1,40:0.5,45:0.5,60:4
});
const weightTotal=Object.values(VIMSHOPAKA_16_WEIGHTS).reduce((a,b)=>a+b,0);
if(weightTotal!==20)throw Error('Shodashavarga weights do not total 20');
const mod=(x,n=12)=>((x%n)+n)%n;
const norm=x=>mod(x,360);
const rnd=(x,places=4)=>Math.round(x*10**places)/10**places;
const sep=(a,b)=>Math.min(norm(a-b),360-norm(a-b));
const info=bodies=>new Map((bodies||[]).filter(b=>Number.isFinite(b?.sidereal?.longitudeDegrees)).map(b=>[b.name,b]));
const sign=b=>Math.floor(norm(b.sidereal.longitudeDegrees)/30);
function resolveDignityScore(planet,targetSign) {
 const ruler=LORDS[targetSign],from=EXALT[planet],point=targetSign;
 if(OWN[planet]?.includes(point)||Math.floor(from/30)===point)return {score:20,kind:'own/exalted'};
 if(Math.floor(mod(from+180,360)/30)===point)return {score:0,kind:'debilitated'};
 if(FRIEND[planet]?.includes(ruler))return {score:15,kind:'natural-friend'};
 if(ENEMY[planet]?.includes(ruler))return {score:7,kind:'natural-enemy'};
 return {score:10,kind:'natural-neutral'};
}
export function calculateAdditionalPlanetStrengths({ascendant,bodies=[],houseSystems={},classicalDivisionalCharts={}}={}){
 const by=info(bodies);
 const asc=Number(ascendant),mc=Number(houseSystems?.W?.points?.mc);
 const sun=by.get('Солнце')?.sidereal?.longitudeDegrees;
 const moon=by.get('Луна')?.sidereal?.longitudeDegrees;
 const elongation=Number.isFinite(sun)&&Number.isFinite(moon)?norm(moon-sun):null;
 const bright=elongation===null?null:60*(1-Math.abs(180-elongation)/180);
 const rows={};
 for(const name of CLASSICAL){
  const b=by.get(name);
  if(!b)continue;
  const lon=b.sidereal.longitudeDegrees,unchanged=sep(lon,EXALT[name]);
  const zero=({Солнце:Number.isFinite(mc)?norm(mc+180):null,
   Марс:Number.isFinite(mc)?norm(mc+180):null,
   Меркурий:Number.isFinite(asc)?norm(asc+180):null,
   Юпитер:Number.isFinite(asc)?norm(asc+180):null,
   Венера:Number.isFinite(mc)?norm(mc):null,
   Луна:Number.isFinite(mc)?norm(mc):null,
   Сатурн:Number.isFinite(asc)?norm(asc):null})[name];
  let vimshopaka=0;const parts=[];
  for(const [division,weight]of Object.entries(VIMSHOPAKA_16_WEIGHTS)){
   const target=classicalDivisionalCharts['D'+division]?.points?.find(x=>x.name===name);
   if(!target)continue;
   const dg=resolveDignityScore(name,target.signIndex);
   const earned=weight*dg.score/20;
   vimshopaka+=earned;
   parts.push({division:Number(division),sign:target.sign,weight,kind:dg.kind,earned:rnd(earned)});
  }
  rows[name]={
   longitudeDegrees:lon,exaltationLongitudeDegrees:EXALT[name],
   uchchaBalaVirupas:rnd(60-unchanged/3),
   digBalaVirupas:Number.isFinite(zero)?rnd(sep(lon,zero)/3):null,
   digZeroLongitudeDegrees:Number.isFinite(zero)?zero:null,
   naisargikaBalaVirupas:rnd(NATURAL[name]),
   pakshaBalaVirupas:bright===null?null:rnd(
    ['Луна','Венера','Юпитер'].includes(name)?bright:
    ['Солнце','Марс','Сатурн'].includes(name)?60-bright:30
   ),
   pakshaClassification:name==='Меркурий'?'neutral-assumption-unafflicted-not-tested':'conventional-benefic-malefic',
   vimshopaka16Points:parts.length===16?rnd(vimshopaka):null,
   vimshopaka16Components:parts
  };
 }
 return {
  method:'Selected Parashari definitions for Uchcha, Dig, Naisargika, Paksha and 16-varga Vimshopaka',
  reference:'BPHS varga weighting / classical positional and directional formulas',
  shadbalaComplete:false,
  partialComponents:['Uchcha Bala','Dig Bala','Naisargika Bala','Paksha Bala'],
  unavailableForTotal:['Saptavargaja Bala','Ojhayugma Bala','Kendradi Bala','Drekkana Bala','Natonnata Bala','Tribhaga Bala','Abda/Masa/Vara/Hora Bala','Ayana Bala','Cheshta Bala','Drik Bala','Graha Yuddha Bala'],
  warning:'Do NOT add these partial components into a total Shadbala. Mercury Paksha uses a neutral 30-virupa placeholder; differing schools require more criteria.',
  vimshopaka16:{weightTotal,scoring:'own or exalted 20; debilitated 0; friend 15; neutral 10; enemy 7 (one explicit convention)',scheme:'Shodashavarga 16; 0-20 weighted points'},
  rows
 };
}
const TRINES=[[0,4,8],[1,5,9],[2,6,10],[3,7,11]];
const SHARED_LORD_SIGNS=[[0,7],[1,6],[2,5],[8,11],[9,10]];
export function calculateAshtakavargaReductions({ashtakavarga,bodies=[]}={}){
 if(ashtakavarga?.total!==337)throw Error('Expected raw BAV/SAV checksum of 337');
 const occupied=new Set([...info(bodies).entries()].filter(([name])=>CLASSICAL.includes(name)).map(([,b])=>sign(b)));
 const reduced={},raw={},reductionStats={};
 for(const [name,record]of Object.entries(ashtakavarga.bhinna)){
  const rawBindus=record.bindus;
  const arr=[...rawBindus];raw[name]=[...rawBindus];
  for(const triple of TRINES){
   const values=triple.map(i=>arr[i]),zeros=values.filter(x=>x===0).length;
   if(new Set(values).size===1||zeros===2){for(const idx of triple)arr[idx]=0;}
   else if(zeros===0){const least=Math.min(...values);for(const idx of triple)arr[idx]-=least;}
  }
  const afterTrikona=[...arr];
  for(const [i,j]of SHARED_LORD_SIGNS){
   if(!arr[i]||!arr[j]||(occupied.has(i)&&occupied.has(j)))continue;
   if(occupied.has(i)&&!occupied.has(j))arr[j]=Math.min(arr[i],arr[j])===arr[i]?arr[i]:0;
   else if(occupied.has(j)&&!occupied.has(i))arr[i]=Math.min(arr[i],arr[j])===arr[j]?arr[j]:0;
   else if(arr[i]===arr[j])arr[i]=arr[j]=0;
   else arr[i]=arr[j]=Math.min(arr[i],arr[j]);
  }
  if(arr.some((v,i)=>v>rawBindus[i]||v<0))throw Error('Ashtakavarga reduction failed monotonicity');
  reduced[name]={afterTrikona,afterEkadhipatya:arr,rawTotal:rawBindus.reduce((a,b)=>a+b,0),
   reducedTotal:arr.reduce((a,b)=>a+b,0)};
  reductionStats[name]={removed:reduced[name].rawTotal-reduced[name].reducedTotal};
 }
 return {method:'Trikona then Ekadhipatya Shodhana, selected school convention; never applied to 337-bindu SAV',
   rawBav:raw,rawSarva:[...ashtakavarga.sarva],reduced,byPlanet:reductionStats,
   savTotal:337,
   warnings:['Reduction algorithms have school-dependent branches; compare with a chosen published school before Shodhya Pinda or longevity use.']};
}
const KENDRA=new Set([1,4,7,10]),TRIKONA=new Set([1,5,9]);
export function calculateClassicalYogaCandidates({ascendant,bodies=[],classicalDivisionalCharts={}}={}){
 const by=info(bodies),ascSign=Math.floor(norm(ascendant)/30);
 const bySign=name=>by.has(name)?sign(by.get(name)):null;
 const from=(signIndex,origin)=>mod(signIndex-origin)+1;
 const house=name=>bySign(name)===null?null:from(bySign(name),ascSign);
 const moonSign=bySign('Луна');
 const cand=[];
 const add=(code,name,participants,reason,qualifier='candidate-only')=>cand.push({code,name,participants,reason,qualifier});
 const sunSign=bySign('Солнце'),merSign=bySign('Меркурий'),marsSign=bySign('Марс'),jupSign=bySign('Юпитер');
 if(sunSign!==null&&sunSign===merSign)add('budha-aditya','Будха-Адитья',['Солнце','Меркурий'],'same sidereal sign; combustion not sufficient to decide outcome');
 if(moonSign!==null&&jupSign!==null&&KENDRA.has(from(jupSign,moonSign)))
  add('gajakesari','Гаджа-Кесари',['Луна','Юпитер'],'Jupiter in a kendra counted from Moon; affliction/cancellation not tested');
 if(moonSign!==null&&marsSign!==null&&[1,7].includes(from(marsSign,moonSign)))
  add('chandra-mangala','Чандра-Мангала',['Луна','Марс'],'Moon and Mars together or in opposition');
 for(const [name,yoga]of [['Марс','Ручака'],['Меркурий','Бхадра'],['Юпитер','Хамса'],['Венера','Малавья'],['Сатурн','Шаша']]){
  const signIndex=bySign(name);if(signIndex===null||!KENDRA.has(house(name)))continue;
  if(OWN[name].includes(signIndex)||Math.floor(EXALT[name]/30)===signIndex)
   add('pancha-mahapurusha-'+name,yoga,[name],'planet in own/exaltation sign and kendra from ascendant');
 }
 const lordOf=h=>LORDS[mod(ascSign+h-1)];
 const dharma=lordOf(9),karma=lordOf(10);
 if(dharma!==karma&&bySign(dharma)!==null&&bySign(dharma)===bySign(karma))
  add('dharma-karma','Дхарма-Кармадхипати',[dharma,karma],'lords of 9th and 10th together');
 for(const h of [6,8,12]){
  const lord=lordOf(h),dest=house(lord);
  if(dest!==null&&[6,8,12].includes(dest))
   add('viparita-'+h,'Випарита-раджа, условие',[lord],'lord of dusthana '+h+' placed in dusthana '+dest);
 }
 const d1=new Map(classicalDivisionalCharts?.D1?.points?.map(p=>[p.name,p.signIndex])||[]);
 for(const p of classicalDivisionalCharts?.D9?.points||[]){
  if(p.name==='Лагна')continue;
  if(d1.has(p.name)&&d1.get(p.name)===p.signIndex)
   add('vargottama-'+p.name,'Варготтама',[p.name],'same Rashi sign in D1 and D9','technical-condition');
 }
 return {method:'Mechanical yoga-candidate screening by sign, lordship and kendra; NO prediction or cancellation verdict',
  count:cand.length,candidates:cand,
  notEvaluated:['full Neechabhanga and Raja Yoga cancellations','all planetary war outcomes','all dozens of source-dependent yoga variants']};
}
