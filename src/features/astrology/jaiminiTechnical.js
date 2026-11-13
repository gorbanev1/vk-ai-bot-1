/**
 * Traditional Jaimini sign aspects and argala scaffolding.
 * Calculates mechanical sign/house relations, not outcome predictions.
 * Requires an existing Swiss-derived Lahiri Rashi; uses no external calls.
 */
const SIGNS=['Овен','Телец','Близнецы','Рак','Лев','Дева','Весы','Скорпион','Стрелец','Козерог','Водолей','Рыбы'];
const MOVABLE=new Set([0,3,6,9]);
const FIXED=new Set([1,4,7,10]);
const DUAL=new Set([2,5,8,11]);
const mod12=n=>((n%12)+12)%12;
function signIndex(lon){
 if(!Number.isFinite(lon))throw new TypeError('Finite sidereal longitude required');
 return Math.floor((((lon%360)+360)%360)/30);
}
export function jaiminiRashiDrishtiTargets(source){
 if(!Number.isInteger(source)||source<0||source>11)throw new RangeError('Rashi index 0..11');
 if(MOVABLE.has(source))return [...FIXED].filter(x=>x!==mod12(source+1)).sort((a,b)=>a-b);
 if(FIXED.has(source))return [...MOVABLE].filter(x=>x!==mod12(source-1)).sort((a,b)=>a-b);
 if(DUAL.has(source))return [...DUAL].filter(x=>x!==source).sort((a,b)=>a-b);
 throw new RangeError('Unknown sign modality');
}
export function calculateJaiminiSignTechnical({ascendant,bodies=[],arudhaPadas=[],charaKarakas=[],classicalDivisionalCharts={}}={}){
 const lagna=signIndex(ascendant);
 const planets=(bodies||[]).filter(x=>Number.isFinite(x?.sidereal?.longitudeDegrees))
  .map(x=>({name:x.name,signIndex:signIndex(x.sidereal.longitudeDegrees)}));
 const bySign=Array.from({length:12},(_,sign)=>planets.filter(p=>p.signIndex===sign).map(p=>p.name));
 const signAspects=Array.from({length:12},(_,from)=>{
  const targets=jaiminiRashiDrishtiTargets(from);
  return {from,sign:SIGNS[from],to:targets,aspectedPlanets:targets.flatMap(t=>bySign[t]),
   sourcePlanets:bySign[from]};
 });
 const argala=Array.from({length:12},(_,house0)=>{
  const reference=mod12(lagna+house0);
  const relationships=[[2,12],[4,10],[11,3],[5,9]];
  return {house:house0+1,referenceSignIndex:reference,
   pairs:relationships.map(([support,obstruction],i)=>{
    const from=mod12(reference+support-1),against=mod12(reference+obstruction-1);
    return {type:i===3?'secondary':'primary',supportHouse:support,obstructionHouse:obstruction,
     supportSignIndex:from,obstructionSignIndex:against,
     supportBodies:bySign[from],obstructionBodies:bySign[against]};
   })};
 });
 const upapada=arudhaPadas?.find(x=>x.house===12&&!x.unavailable)??null;
 const atmakaraka=charaKarakas?.find(x=>/атма|atmakaraka|атмакарака/iu.test(x.karaka||''))??charaKarakas?.[0]??null;
 const d9Planet=classicalDivisionalCharts?.D9?.points?.find(x=>x.name===atmakaraka?.body);
 return {
  method:'Jaimini Rashi Drishti and Argala, selected standard sign convention',
  signAspects,argala,upapadaLagna:upapada?{signIndex:upapada.arudhaSignIndex,sign:upapada.arudhaSign}:null,
  karakamsha:d9Planet?{atmakaraka:atmakaraka.body,signIndex:d9Planet.signIndex,sign:d9Planet.sign}:null,
  cautions:[
   'Rashi Drishti differs from Parashari Graha Drishti.',
   'Argala pairs are listed as contributing/obstructing locations; no strength or cancellation verdict is inferred.',
   'Jaimini Karakamsha assumes the selected Chara Karaka convention and D9 map.',
  ]
 };
}
const SHODASHA=Object.freeze({1:3.5,2:1,3:1,4:0.5,7:0.5,9:3,10:0.5,12:0.5,16:2,20:0.5,24:0.5,27:0.5,30:1,40:0.5,45:0.5,60:4});
const SIX=Object.freeze({1:6,2:2,3:4,9:5,12:2,30:1});
const SEVEN=Object.freeze({1:5,2:2,3:3,7:2.5,9:4.5,12:2,30:1});
const TEN=Object.freeze({1:3,2:1.5,3:1.5,7:1.5,9:1.5,10:1.5,12:1.5,16:1.5,30:1.5,60:5});
export const VIMSHOPAKA_SCHEMES=Object.freeze({shadvarga:SIX,saptavarga:SEVEN,dashavarga:TEN,shodashavarga:SHODASHA});
for(const [name,weights]of Object.entries(VIMSHOPAKA_SCHEMES)){
 if(Object.values(weights).reduce((sum,n)=>sum+n,0)!==20)throw new Error('Invalid Vimshopaka '+name+' weights');
}
const CLASS_SCORES={'own/exalted':20,'debilitated':0,'natural-friend':15,'natural-neutral':10,'natural-enemy':7};
export function calculateAllVimshopakaSchemes(partialStrengths){
 const rows={};
 for(const [name,row]of Object.entries(partialStrengths?.rows||{})){
  const components=new Map((row.vimshopaka16Components||[]).map(x=>[x.division,x]));
  rows[name]={};
  for(const [scheme,weights]of Object.entries(VIMSHOPAKA_SCHEMES)){
   let score=0;
   const detail=[];
   for(const [d,w]of Object.entries(weights)){
    const component=components.get(Number(d));
    if(!component || !Object.hasOwn(CLASS_SCORES,component.kind)){
     throw Error('Missing/varying dignity scheme '+scheme+' for '+name+' D'+d);
    }
    const earned=w*CLASS_SCORES[component.kind]/20;
    score+=earned;
    detail.push([Number(d),w,component.kind,Math.round(earned*10000)/10000]);
   }
   rows[name][scheme]={points:Math.round(score*10000)/10000,components:detail};
  }
 }
 return {method:'Four classical 20-point Vimshopaka weight schemes using existing explicit selected dignity categories',
  scores:rows,weightSets:VIMSHOPAKA_SCHEMES,
  interpretationCaution:'Dignity and natural friendship categories are convention dependent, do not equate Vimshopaka with complete Shadbala.'};
}
