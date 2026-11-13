import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 calculateAdditionalPlanetStrengths,calculateAshtakavargaReductions,
 calculateClassicalYogaCandidates,VIMSHOPAKA_16_WEIGHTS
} from '../../src/features/astrology/technicalJyotishSupplement.js';
import {calculateClassicalDivisionalCharts,calculateAshtakavarga} from '../../src/features/astrology/classicalJyotishExtensions.js';
const names=['Солнце','Луна','Марс','Меркурий','Юпитер','Венера','Сатурн','Раху истинный'];
function fixtures(longitudes=[10,33,298,165,95,357,200,15]){
 return names.map((name,i)=>({name,sidereal:{longitudeDegrees:longitudes[i]}}));
}
test('Uchcha Bala exact exaltation 60 and debilitation 0 for seven classic planets',()=>{
 for(const name of names.slice(0,7)){
  const bodies=fixtures();
  const asc=20,charts=calculateClassicalDivisionalCharts({ascendant:asc,bodies});
  const r=calculateAdditionalPlanetStrengths({ascendant:asc,bodies,classicalDivisionalCharts:charts,houseSystems:{W:{points:{mc:290}}}});
  assert.equal(r.rows[name].uchchaBalaVirupas,60,name);
  assert.equal(r.rows[name].vimshopaka16Components.length,16,name);
  assert.ok(r.rows[name].vimshopaka16Points>=0&&r.rows[name].vimshopaka16Points<=20);
  const changed=bodies.map(b=>b.name===name?{...b,sidereal:{longitudeDegrees:(b.sidereal.longitudeDegrees+180)%360}}:b);
  assert.equal(calculateAdditionalPlanetStrengths({ascendant:asc,bodies:changed,classicalDivisionalCharts:calculateClassicalDivisionalCharts({ascendant:asc,bodies:changed})}).rows[name].uchchaBalaVirupas,0,name);
 }
 assert.equal(Object.values(VIMSHOPAKA_16_WEIGHTS).reduce((a,b)=>a+b,0),20);
});
test('Dig Bala maximum opposite zero direction, and minimum at zero',()=>{
 const bodies=fixtures([290,290,0,0,0,0,0,0]);
 const q=calculateAdditionalPlanetStrengths({ascendant:0,bodies,houseSystems:{W:{points:{mc:110}}}});
 assert.equal(q.rows['Солнце'].digBalaVirupas,0);
 assert.equal(q.rows['Луна'].digBalaVirupas,60);
});
test('traditional reductions never modify unreduced 337 SAV',()=>{
 const bodies=fixtures();
 const base=calculateAshtakavarga({ascendant:20,bodies});
 const previous=JSON.stringify(base);
 const result=calculateAshtakavargaReductions({ashtakavarga:base,bodies});
 assert.equal(result.savTotal,337);
 assert.deepEqual(result.rawSarva,base.sarva);
 assert.equal(JSON.stringify(base),previous);
 for(const [name,r]of Object.entries(result.reduced)){
  assert.equal(r.afterTrikona.length,12);
  assert.ok(r.afterEkadhipatya.every((x,i)=>x>=0&&x<=base.bhinna[name].bindus[i]));
 }
});
test('yoga screening produces only candidates and does not fabricate verdicts',()=>{
 const bodies=fixtures([10,40,40,12,42,55,110,130]);
 const out=calculateClassicalYogaCandidates({ascendant:5,bodies,classicalDivisionalCharts:calculateClassicalDivisionalCharts({ascendant:5,bodies})});
 assert.equal(out.method.includes('NO prediction'),true);
 assert.equal(out.candidates.some(x=>x.code==='budha-aditya'),true);
 assert.equal(out.candidates.some(x=>x.code==='chandra-mangala'),true);
});
test('supplement source is wired into the local Swiss maximum packet',()=>{
 const app=readFileSync(process.env.GIGORAVE_STAGED_ASTRO||new URL('../../src/features/astrology/ephemeris.js',import.meta.url),'utf8');
 for(const x of ['calculateAdditionalPlanetStrengths(','calculateAshtakavargaReductions(','calculateClassicalYogaCandidates('])
  assert.ok(app.includes(x),x);
});
