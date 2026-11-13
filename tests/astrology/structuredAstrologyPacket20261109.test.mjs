import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareLocalSwissEphemerisRuntime} from '../../src/features/astrology/astrologyRuntimeFallback.js';

const load=async()=>{
 prepareLocalSwissEphemerisRuntime();
 const target=process.env.GIGORAVE_STAGED_SWISS_MODULE?'../../src/features/astrology/ephemeris-structured-next.mjs':'../../src/features/astrology/ephemeris.js';
 return import(target);
};
const calculate=async(input={})=>{
 const {calculateJyotishPrashna}=await load();
 return calculateJyotishPrashna({date:new Date('2026-11-09T16:00:00Z'),periodReferenceDate:new Date('2026-11-09T16:00:00Z'),
  latitude:51.6608,longitude:39.2003,locationName:'Воронеж',timeZone:'Europe/Moscow',...input});
};
test('real Swiss maximum uses compact structured packet and all local methods',async()=>{
 const result=await calculate();
 const r=result.data,p=JSON.parse(result.gptPayloadMaximum);
 assert.equal(r.audit.completeForDeclaredScope,true);
 assert.equal(r.engine.coreCalculationsUsedSwissFiles,true);
 assert.equal(p.schema,'gigorave-sweph-structured-v2');
 assert.equal(p.sourceSchema,r.schema);
 assert.equal(Object.keys(r.classicalDivisionalCharts).length,16);
 assert.equal(Object.keys(r.harmonicCharts).length,60);
 assert.equal(r.ashtakavarga.total,337);
 assert.equal(r.jaiminiTechnical.signAspects.length,12);
 assert.equal(r.vimshopakaAllSchemes.weightSets.shadvarga[1],6);
 assert.equal(Object.keys(r.vimshopakaAllSchemes.weightSets).length,4);
 assert.equal(r.shadbalaComponents.shadbalaComplete,false);
 assert.equal(Object.keys(r.ashtakavargaReductions.reduced).length,7);
 assert.equal(p.bodyTable.rows.length,r.bodies.length);
 assert.equal(p.houseTable.rows.length,Object.keys(r.houseSystems).length);
 assert.equal(p.harmonicCharts.rows.length,60);
 assert.equal(p.traditionalVargas.charts.length,16);
 assert.equal(p.vimshottari.praty.length,729);
 assert.equal(p.vimshottari.antara.length,81);
 assert.equal(p.vimshottari.maha.length,9);
 assert.equal(p.fixedStars.length,10);
 assert.equal(p.jaimini.signAspects.length,12);
 assert.equal(p.ashtakavarga.total,337);
 assert.equal(p.strengths.rows.length,7);
 assert.equal(p.yogaCandidates.count,r.yogaCandidates.count);
 assert.ok(result.statistics.structuredPayloadBytes>10000);
 assert.equal(result.statistics.structuredPayloadSchema,p.schema);
 assert.equal(result.gptPayloadStructuredMaximum,result.gptPayloadMaximum);
 assert.ok(Buffer.byteLength(result.gptPayloadMaximum)<Buffer.byteLength(JSON.stringify(r))*0.45);
});
test('structured technical positions preserve principal Swiss longitude and complete Dasha period indexing',async()=>{
 const result=await calculate();
 const data=result.data,packet=JSON.parse(result.gptPayloadMaximum);
 const sun=packet.bodyTable.rows.find(x=>x[0]==='Солнце');
 const local=data.bodies.find(x=>x.name==='Солнце');
 assert.ok(Math.abs(sun[3][0]-local.sidereal.longitudeDegrees)<0.00001);
 const fullDasha=data.jyotishDerived.vimshottariDasha;
 assert.equal(packet.vimshottari.maha.length,fullDasha.mahadashas.length);
 assert.equal(packet.vimshottari.praty.length,fullDasha.mahadashas.reduce((total,m)=>total+m.antardashas.reduce((n,a)=>n+a.pratyantardashas.length,0),0));
 assert.ok(packet.vimshottari.lords.length===9);
 assert.ok(packet.bodyTable.fields.nodeApsides.length===6);
 assert.ok(packet.bodyTable.fields.orbit.length>=15);
 assert.ok(packet.jaimini.argala.length===12);
 assert.equal(packet.vimshopakaSchemes.rows.length,7);
});
