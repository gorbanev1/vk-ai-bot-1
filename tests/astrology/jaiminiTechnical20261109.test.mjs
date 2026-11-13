import test from 'node:test';import assert from 'node:assert/strict';
import {jaiminiRashiDrishtiTargets,calculateJaiminiSignTechnical,calculateAllVimshopakaSchemes,VIMSHOPAKA_SCHEMES} from '../../src/features/astrology/jaiminiTechnical.js';
import {calculateClassicalDivisionalCharts} from '../../src/features/astrology/classicalJyotishExtensions.js';
import {calculateAdditionalPlanetStrengths} from '../../src/features/astrology/technicalJyotishSupplement.js';
test('Jaimini movable/fixed/dual Rashi Drishti aspects exactly three signs',()=>{
 assert.deepEqual(jaiminiRashiDrishtiTargets(0),[4,7,10]); // Aries, not Taurus
 assert.deepEqual(jaiminiRashiDrishtiTargets(1),[3,6,9]); // Taurus, not Aries
 assert.deepEqual(jaiminiRashiDrishtiTargets(2),[5,8,11]); // Gemini to other dual
 assert.equal(Array.from({length:12},(_,i)=>jaiminiRashiDrishtiTargets(i).length).every(n=>n===3),true);
 for(let i=0;i<12;i++)for(const t of jaiminiRashiDrishtiTargets(i))assert.ok(jaiminiRashiDrishtiTargets(t).includes(i),'mutual aspects');
});
test('Argala indicators include contributing and obstructing planets without verdicts',()=>{
 const bodies=[{name:'Солнце',sidereal:{longitudeDegrees:46}},{name:'Марс',sidereal:{longitudeDegrees:332}},{name:'Луна',sidereal:{longitudeDegrees:96}}];
 const x=calculateJaiminiSignTechnical({ascendant:10,bodies,arudhaPadas:[{house:12,arudhaSignIndex:8,arudhaSign:'Стрелец'}],charaKarakas:[{karaka:'Атмакарака',body:'Солнце'}],
 classicalDivisionalCharts:calculateClassicalDivisionalCharts({ascendant:10,bodies})});
 assert.equal(x.signAspects.length,12);assert.equal(x.argala.length,12);
 assert.equal(x.argala[0].pairs[0].supportHouse,2);
 assert.equal(x.argala[0].pairs[0].obstructionHouse,12);
 assert.deepEqual(x.argala[0].pairs[0].supportBodies,['Солнце']);
 assert.deepEqual(x.argala[0].pairs[0].obstructionBodies,['Марс']);
 assert.equal(x.upapadaLagna.sign,'Стрелец');
 assert.equal(x.karakamsha.atmakaraka,'Солнце');
});
test('Vimshopaka all four classical weight schemes each sum to twenty',()=>{
 for(const weights of Object.values(VIMSHOPAKA_SCHEMES))assert.equal(Object.values(weights).reduce((a,b)=>a+b,0),20);
 const names=['Солнце','Луна','Марс','Меркурий','Юпитер','Венера','Сатурн'];
 const bodies=names.map((name,i)=>({name,sidereal:{longitudeDegrees:15+i*41.78}}));
 const charts=calculateClassicalDivisionalCharts({ascendant:15,bodies});
 const strengths=calculateAdditionalPlanetStrengths({ascendant:15,bodies,classicalDivisionalCharts:charts});
 const x=calculateAllVimshopakaSchemes(strengths);
 assert.equal(Object.keys(x.scores).length,7);
 for(const p of Object.values(x.scores))for(const q of Object.values(p)){
  assert.ok(q.points>=0&&q.points<=20);
  assert.ok(q.components.length===6||q.components.length===7||q.components.length===10||q.components.length===16);
 }
});
