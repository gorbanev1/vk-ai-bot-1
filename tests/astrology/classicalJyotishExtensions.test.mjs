import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateTraditionalVargaPosition as pos,SHODASHAVARGA_DIVISIONS as ALL,
 calculateClassicalDivisionalCharts,calculateAshtakavarga,calculateReferenceHouseCharts,
 calculateActiveVimshottariMicroPeriods,calculatePartialNaturalBala} from '../../src/features/astrology/classicalJyotishExtensions.js';
const bodies=['Солнце','Луна','Марс','Меркурий','Юпитер','Венера','Сатурн','Раху истинный','Кету истинный']
 .map((name,i)=>({name,sidereal:{longitudeDegrees:i*38.1234+1}}));
test('sixteen traditional vargas differ from 60 harmonic longitudes and include own houses',()=>{
 const charts=calculateClassicalDivisionalCharts({ascendant:14.6,bodies,ascendantSpeedDegreesPerDay:345});
 assert.deepEqual(Object.keys(charts).map(x=>Number(x.slice(1))),ALL);
 assert.equal(charts.D2.points[0].sign,'Лев');
 assert.equal(charts.D2.points[0].houseFromVargaLagna,1);
 assert.equal(charts.D3.points.find(x=>x.name==='Луна').houseFromVargaLagna>=1,true);
 assert.equal(charts.D9.points.length,10);
 assert.equal(charts.D60.points.length,10);
 assert.ok(charts.D60.lagnaBoundaryMinutesEstimate>0);
 assert.ok(charts.D60.lagnaBoundaryMinutesEstimate<3);
});
test('Parashari rules D2 D3 D4 D7 D9 D10 D12 are independent and correct',()=>{
 const eq=(lng,n,expected)=>assert.equal(pos(lng,n).signIndex,expected,'D'+n+' @ '+lng);
 eq(2,2,4);eq(22,2,3);eq(32,2,3);eq(47,2,4);
 eq(11,3,4);eq(21,3,8);
 eq(8,4,3);eq(16,4,6);eq(24,4,9);
 eq(0.1,7,0);eq(30.1,7,7);
 eq(0.1,9,0);eq(30.1,9,9);eq(60.1,9,6);
 eq(0.1,10,0);eq(30.1,10,9);
 eq(35.1,12,3);
});
test('D16 D20 D24 D27 D30 D40 D45 D60 follow selected counting convention',()=>{
 const eq=(lng,n,expected)=>assert.equal(pos(lng,n).signIndex,expected,'D'+n+' @ '+lng);
 eq(0.1,16,0);eq(30.1,16,4);eq(60.1,16,8);
 eq(0.1,20,0);eq(30.1,20,8);eq(60.1,20,4);
 eq(0.1,24,4);eq(30.1,24,3);
 eq(0.1,27,0);eq(30.1,27,3);eq(60.1,27,6);eq(90.1,27,9);
 eq(0.1,30,0);eq(6,30,10);eq(12,30,8);eq(20,30,2);eq(29,30,6);
 eq(30.1,30,1);eq(36,30,5);eq(42,30,11);eq(51,30,9);eq(58,30,7);
 eq(0.1,40,0);eq(30.1,40,6);
 eq(0.1,45,0);eq(30.1,45,4);eq(60.1,45,8);
 eq(0.1,60,0);eq(0.6,60,1);eq(30.6,60,2);
});
test('horoscopes include lagna, moon, sun and arudha reference houses',()=>{
 const charts=calculateReferenceHouseCharts({ascendant:30,bodies,arudhaSignIndex:10});
 assert.deepEqual(Object.keys(charts),['lagna','chandra','surya','arudha']);
 for(const chart of Object.values(charts)){
  assert.equal(chart.planets.length,10);
  assert.ok(chart.planets.every(x=>x.house>=1&&x.house<=12));
 }
});
test('Ashtakavarga has 7 BAV matrices (0..8) and exact 337 SAV bindus',()=>{
 const table=calculateAshtakavarga({ascendant:15,bodies});
 assert.equal(table.total,337);
 assert.deepEqual(Object.values(table.bhinna).map(row=>row.total),[48,49,39,54,56,52,39]);
 assert.equal(table.sarva.length,12);
 assert.equal(table.sarva.reduce((n,x)=>n+x,0),337);
 assert.ok(Object.values(table.bhinna).every(row=>row.bindus.every(x=>x>=0&&x<=8)));
 assert.equal(table.houseBindusFromLagna[0],table.sarva[0]);
});
test('Vimshottari Sookshma and Prana are deterministic active period subdivisions',()=>{
 const t0=new Date('2026-11-09T00:00:00Z'),at=new Date(t0.getTime()+1000000);
 const data=calculateActiveVimshottariMicroPeriods({activePratyantardasha:{
  lord:'Юпитер',startUtcIso:t0.toISOString(),endUtcIso:new Date(t0.getTime()+9000000).toISOString()
 }},at);
 assert.equal(data.sookshmaPeriods.length,9);
 assert.equal(data.pranaPeriods.length,9);
 assert.ok(data.activeSookshma);
 assert.ok(data.activePrana);
 assert.equal(data.sookshmaPeriods[0].lord,'Юпитер');
 const natural=calculatePartialNaturalBala({bodies});
 assert.equal(natural.values['Солнце'],60);
 assert.equal(natural.completeShadbala,false);
});
test('production Swiss engine includes additional data in full GPT payload and audits',()=>{
 const code=readFileSync(process.env.GIGORAVE_STAGED_ASTRO_SOURCE||new URL('../../src/features/astrology/ephemeris.js',import.meta.url),'utf8');
 assert.match(code,/calculateClassicalDivisionalCharts\(/u);
 assert.match(code,/calculateAshtakavarga\(/u);
 assert.match(code,/classicalDivisionalCharts,/u);
 assert.match(code,/ashtakavarga,/u);
 assert.match(code,/activeSookshma/u);
});
