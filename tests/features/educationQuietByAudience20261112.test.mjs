import test from 'node:test';
import assert from 'node:assert/strict';
import {isHuinglishQuietTime,nextHuinglishActiveTime,addHuinglishActiveMilliseconds} from '../../src/features/english/huinglishQuietHours.js';
const m=x=>Date.parse('2026-11-12T'+x+':00+03:00');
test('private education quiet 21:30 through 09:59 Moscow',()=>{
 for(const hm of ['00:00','01:30','06:30','09:59','21:30','23:59'])
  assert.equal(isHuinglishQuietTime(m(hm),'Europe/Moscow','private'),true,hm);
 for(const hm of ['10:00','15:00','21:29'])
  assert.equal(isHuinglishQuietTime(m(hm),'Europe/Moscow','private'),false,hm);
 assert.equal(nextHuinglishActiveTime(m('23:20'),'Europe/Moscow','private'),
  Date.parse('2026-11-13T10:00:00+03:00'));
 assert.equal(addHuinglishActiveMilliseconds(m('21:29'),3*60000,'Europe/Moscow','private'),
  Date.parse('2026-11-13T10:02:00+03:00'));
});
test('group quiet 01:30 to 06:30 only',()=>{
 for(const hm of ['01:30','03:00','06:29'])
  assert.equal(isHuinglishQuietTime(m(hm),'Europe/Moscow','group'),true,hm);
 for(const hm of ['00:00','01:29','06:30','21:30','23:59'])
  assert.equal(isHuinglishQuietTime(m(hm),'Europe/Moscow','group'),false,hm);
 assert.equal(nextHuinglishActiveTime(m('03:00'),'Europe/Moscow','group'),m('06:30'));
 assert.equal(addHuinglishActiveMilliseconds(m('01:29'),120000,'Europe/Moscow','group'),m('06:31'));
});
