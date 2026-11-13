/**
 * Compact, loss-aware and auditable structured data packet for GPT.
 * Every astronomically unique section remains in the full in-memory result.
 * The packet removes duplicated derived labels and serializes full 120-year
 * Vimshottari timeline as an index-coded table instead of deep repeated JSON.
 */
import {createHash} from 'node:crypto';

const n=(value,precision=5)=>Number.isFinite(value)?Number(value.toFixed(precision)):null;
const arr=(obj,keys,precision=6)=>keys.map(key=>n(obj?.[key],precision));
const slim=(value,depth=0)=>{
 if(value==null || typeof value==='boolean'||typeof value==='string')return value;
 if(typeof value==='number')return n(value,6);
 if(depth>10)return '[nested data retained locally]';
 if(Array.isArray(value))return value.map(v=>slim(v,depth+1));
 if(typeof value==='object'){
  const o={};
  for(const [key,v] of Object.entries(value)){
   if(v===undefined||key==='zodiac' && depth>0)continue;
   o[key]=slim(v,depth+1);
  }
  return o;
 }
 return String(value);
};
function compressDasha(dasha){
 if(!dasha)return null;
 const root=Date.parse(dasha.estimatedCycleStartUtcIso);
 if(!Number.isFinite(root))return null;
 const minutes=p=>n((Date.parse(p.startUtcIso)-root)/60000,5);
 const detail=p=>p?[lordIndex(p.lord),minutes(p),n((Date.parse(p.endUtcIso)-root)/60000,5)]:null;
 const maha=[],antara=[],praty=[];
 for(const [mi,m]of (dasha.mahadashas||[]).entries()){
  maha.push([lordIndex(m.lord),minutes(m)]);
  for(const [ai,a]of (m.antardashas||[]).entries()){
   antara.push([mi,lordIndex(a.lord),minutes(a)]);
   for(const p of (a.pratyantardashas||[]))praty.push([mi,ai,lordIndex(p.lord),minutes(p)]);
  }
 }
 const micro=dasha.activeMicroPeriods;
 return {
  lords:DASH_LORDS,
  timeEncoding:'minutes since cycleStart UTC; periods end when next sibling starts; last child ends at parent end',
  cycleStart:dasha.estimatedCycleStartUtcIso,
  cycleEnd:dasha.mahadashas?.at(-1)?.endUtcIso??null,
  yearLengthDays:dasha.yearLengthDays,
  moonNakshatra:dasha.moonNakshatra,balanceYears:n(dasha.balanceYearsAtBirth,5),
  maha,antara,praty,
  active:[detail(dasha.activeMahadasha),detail(dasha.activeAntardasha),detail(dasha.activePratyantardasha),detail(dasha.activeSookshma),detail(dasha.activePrana)],
  micro:micro?[micro.sookshmaPeriods?.map(detail),micro.pranaPeriods?.map(detail)]:null
 };
}
function packHouses(input){
 return Object.values(input||{}).map(h=>[
  h.code,h.name,
  (h.cusps||[]).map(x=>[n(x.longitude,6),n(x.speedDegreesPerDay,5)]),
  arr(h.points,['ascendant','mc','armc','vertex','equatorialAscendant','coAscendantKoch','coAscendantMunkasey','polarAscendant'],6),
  arr(h.pointSpeeds,['ascendant','mc','armc','vertex','equatorialAscendant','coAscendantKoch','coAscendantMunkasey','polarAscendant'],6)
 ]);
}
const ORBITAL_FIELDS=['semimajorAxisAu','eccentricity','inclinationDegrees','ascendingNodeLongitudeDegrees','argumentOfPeriapsisDegrees','periapsisLongitudeDegrees','meanAnomalyDegrees','trueAnomalyDegrees','eccentricAnomalyDegrees','meanLongitudeDegrees','siderealPeriodYears','meanDailyMotionDegrees','tropicalPeriodYears','synodicPeriodDays','perihelionPassageJulianDay','perihelionDistanceAu','aphelionDistanceAu'];
const NODE_APSIDES_FIELDS=['longitudeDegrees','latitudeDegrees','distanceAu','longitudeSpeedDegreesPerDay','latitudeSpeedDegreesPerDay','distanceSpeedAuPerDay'];
const NODE_APSIDES_KINDS=['ascendingNode','descendingNode','perihelion','aphelion'];
const EVENT_FIELDS=['rise','set','upperTransit','lowerTransit'];
const FLAG_FIELDS=['sidereal','tropical','equatorial','topocentricSidereal','topocentricEquatorial'];
const DASH_LORDS=['Кету','Венера','Солнце','Луна','Марс','Раху','Юпитер','Сатурн','Меркурий'];
const packNode=x=>x?NODE_APSIDES_KINDS.map(name=>arr(x[name],NODE_APSIDES_FIELDS,8)):null;
const packNodes=x=>x?[packNode(x.mean),packNode(x.osculating)]:null;
const packFlags=x=>x?FLAG_FIELDS.map(name=>{const p=x[name];return p?[p.requested??null,p.returned??null,p.error??null]:null}):null;
const packEvents=x=>x?EVENT_FIELDS.map(name=>x[name]?[n(x[name].julianDayUt,8),x[name].utcIso]:null):null;
const lordIndex=name=>{const index=DASH_LORDS.indexOf(name);return index<0?name:index};
function packBodies(bodies){
 const fieldDefinitions={
  sid:['longitudeDegrees','latitudeDegrees','distanceAu','longitudeSpeedDegreesPerDay','latitudeSpeedDegreesPerDay','distanceSpeedAuPerDay'],
  eq:['rightAscensionDegrees','rightAscensionHours','declinationDegrees','distanceAu','rightAscensionSpeedDegreesPerDay','declinationSpeedDegreesPerDay','distanceSpeedAuPerDay'],
  hz:['azimuthDegrees','trueAltitudeDegrees','apparentAltitudeDegrees'],
  ph:['phaseAngleDegrees','illuminatedFraction','elongationDegrees','apparentDiameterDegrees','apparentMagnitude','horizontalParallaxDegrees']
 };
 return {
  fields:{...fieldDefinitions,orbit:ORBITAL_FIELDS,nodeApsides:NODE_APSIDES_FIELDS,nodeKinds:NODE_APSIDES_KINDS,eventNames:EVENT_FIELDS,flagNames:FLAG_FIELDS},
  bodyColumns:['name','id','category','sid','tropical','topoSid','eq','topoEq','horizontal','phenomena','jyotish','flags','orbital','nodesApsides','events'],
  rows:(bodies||[]).map(b=>[
   b.name,b.id,b.category,
   arr(b.sidereal,fieldDefinitions.sid),arr(b.tropical,fieldDefinitions.sid),
   arr(b.topocentricSidereal,fieldDefinitions.sid),
   arr(b.equatorial,fieldDefinitions.eq),arr(b.topocentricEquatorial,fieldDefinitions.eq),
   arr(b.horizontal,fieldDefinitions.hz),arr(b.phenomena,fieldDefinitions.ph),
   b.jyotish?[b.jyotish.signIndex,n(b.jyotish.degreesInSign,5),b.jyotish.wholeSignHouse,
    b.jyotish.nakshatra?.name,b.jyotish.nakshatra?.pada,b.jyotish.retrograde?1:0,
    b.jyotish.signLord,b.jyotish.dignity]:null,
   packFlags(b.calculationFlags),b.orbitalElements?arr(b.orbitalElements,ORBITAL_FIELDS,8):null,packNodes(b.nodesAndApsides),packEvents(b.events)
  ])
 };
}
function packDivisions(charts){
 const all=Object.values(charts||{});
 const pointNames=all[0]?.points?.map(p=>p.name)??[];
 return {pointNames,fields:['division','lagnaSignIndex','[signIndex,house,partIndex,degreesInPortion]'],
  charts:all.map(x=>[x.division,x.lagnaSignIndex,
   x.points.map(p=>[p.signIndex,p.houseFromVargaLagna,p.partIndex,n(p.degreesInsidePortion,5)])]),
  annotations:all.filter(x=>x.note||x.division===9).map(x=>[x.division,x.note||null,x.vargottama||null])
 };
}
function packHarmonics(harmonics){
 const charts=Object.values(harmonics||{});
 return {pointNames:charts[0]?.points?.map(p=>p.name)??[],
  rule:'geometric harmonic projection; NOT equivalent to special Parashari sign assignment',
  rows:charts.map(c=>[c.division,c.points.map(p=>n(p.longitudeDegrees,6))])
 };
}
function packAshtakavarga(a,reduced){
 return {signs:a.signs,columns:['planet','12 bindu by sign','raw total'],
  bhinna:Object.entries(a.bhinna||{}).map(([name,v])=>[name,v.bindus,v.total]),
  sarva:a.sarva,total:a.total,byLagna:a.houseBindusFromLagna,
  reduced:reduced?Object.entries(reduced.reduced||{}).map(([name,r])=>[name,r.afterTrikona,r.afterEkadhipatya,r.reducedTotal]):null,
  reductionsAreSchoolDependent:!!reduced};
}
function packStrengths(extra,natural){
 const rows=Object.entries(extra?.rows||{}).map(([name,v])=>[
  name,v.uchchaBalaVirupas,v.digBalaVirupas,v.naisargikaBalaVirupas,v.pakshaBalaVirupas,
  v.vimshopaka16Points,
  v.vimshopaka16Components?.map(c=>[c.division,c.weight,c.earned,c.kind])
 ]);
 return {columns:['planet','uchcha','dig','naisargika','paksha','vimshopaka16 /20','varga components'],
  rows,completeShadbala:false,missing:extra?.unavailableForTotal||natural?.missing,
  warning:'These partial balas must NOT be summed as complete Shadbala. Dignity scoring and reductions depend on declared lineage.'};
}
function packRelationships(r){
 return {majorAspects:(r.majorAspects||[]).map(x=>[x.body1,x.body2,x.aspect,n(x.actualAngleDegrees,5),n(x.orbDegrees,5),x.applyingApprox?1:0]),
  aspectFields:['body1','body2','aspect','actualDegrees','orbDegrees','applying'],
  angularSeparationMatrix:(r.angularSeparationMatrix||[]).map(x=>[x.body1,x.body2,n(x.separationDegrees,5)]),
  planetWarCandidates:slim(r.planetaryWarCandidates)
 };
}
function packVimshopaka(x){
 if(!x)return null;
 return {schemeWeights:x.weightSets,columns:['planet','6-var','7-var','10-var','16-var'],
 rows:Object.entries(x.scores||{}).map(([name,v])=>[name,v.shadvarga?.points,v.saptavarga?.points,v.dashavarga?.points,v.shodashavarga?.points]),
 warnings:x.interpretationCaution};
}
function packJaimini(x){
 if(!x)return null;
 return {signAspectFields:['from','targets','sourcePlanets','aspectedPlanets'],
 signAspects:x.signAspects.map(v=>[v.from,v.to,v.sourcePlanets,v.aspectedPlanets]),
 argalaFields:['house','[supportSign,obstructSign,supportPlanets,obstructPlanets]'],
 argala:x.argala.map(v=>[v.house,v.pairs.map(p=>[p.supportSignIndex,p.obstructionSignIndex,p.supportBodies,p.obstructionBodies])]),
 upapada:x.upapadaLagna,karakamsha:x.karakamsha,cautions:x.cautions};
}
export function buildStructuredAstrologyPacket(data){
 if(!data?.audit?.completeForDeclaredScope)throw Error('Cannot export incomplete local astrology calculation');
 if(Object.keys(data.classicalDivisionalCharts??{}).length!==16||
  Object.keys(data.harmonicCharts??{}).length!==60||
  data.ashtakavarga?.total!==337)throw Error('Full structured packet requires all declared local vargas, harmonics and SAV');
 const d=data.jyotishDerived;
 const derived={...d};delete derived.vimshottariDasha;delete derived.panchangaSnapshot;
 const packet={
  schema:'gigorave-sweph-structured-v2',
  sourceSchema:data.schema,
  units:{angles:'degrees',time:'UTC',speed:'degrees/day',distance:'AU',strength:'virupas'},
  method:'Swiss Ephemeris numeric positions; school-specific derived methods clearly labeled',
  input:slim(data.input),
  engine:{
   version:data.engine.version,computation:data.engine.calculationEngine,
   sidereal:data.engine.siderealMode,swissConfirmed:data.engine.coreCalculationsUsedSwissFiles,
   ephemerisFiles:data.engine.highPrecisionFilesLoaded,
   fallback:data.engine.fallbackUsed
  },
  time:slim(data.time),
  ayanamsas:slim(data.ayanamsas),
  angles:slim(data.angles),
  panchanga:slim(data.panchanga),
  bodyTable:packBodies(data.bodies),
  houseTable:{columns:['system','name','[cusp longitude,speed]','key points','key point speeds'],
   rows:packHouses(data.houseSystems)},
  traditionalVargas:packDivisions(data.classicalDivisionalCharts),
  harmonicCharts:packHarmonics(data.harmonicCharts),
  referenceCharts:Object.entries(data.referenceCharts||{}).map(([id,x])=>[id,x.referenceSignIndex,
   (x.planets||[]).map(p=>[p.name,p.signIndex,p.house])]),
  ashtakavarga:packAshtakavarga(data.ashtakavarga,data.ashtakavargaReductions),
  strengths:packStrengths(data.shadbalaComponents??data.additionalPlanetStrengths,data.naturalStrengthBala),
  vimshopakaSchemes:packVimshopaka(data.vimshopakaAllSchemes),
  jaimini:packJaimini(data.jaiminiTechnical),
  yogaCandidates:slim(data.yogaCandidates??data.classicalYogaCandidates),
  derived:slim(derived),
  relationships:packRelationships(data.relationships),
  vimshottari:compressDasha(d.vimshottariDasha),
  fixedStars:(data.fixedStars||[]).map(x=>[x.requestedName,x.resolvedName,
   arr(x.position,['longitudeDegrees','latitudeDegrees','distanceAu'],6),slim(x.magnitude)]),
  audit:{
   precision:data.audit.precision,verified:data.audit.completeForDeclaredScope,
   counts:data.audit.counts,
   criticalIssues:data.audit.criticalIssues,
   optionalGaps:data.audit.optionalGaps,
   limitations:data.audit.limitations,
  },
  warnings:data.warnings,
 };
 // Avoid serializing full natal data in stdout: return a payload string and metrics.
 const payload=JSON.stringify(packet);
 const fingerprint=createHash('sha256').update(payload).digest('hex').slice(0,16);
 return {payload,packet,fingerprint,bytes:Buffer.byteLength(payload,'utf8'),characters:payload.length};
}
