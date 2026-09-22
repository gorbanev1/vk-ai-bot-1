import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const js = await readFile(new URL('../../miniapps/pinball/pinball.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../miniapps/pinball/index.html', import.meta.url), 'utf8');

const bumpers = [
  { id:'B1', kick:1080, minExitSpeed:1250 },
  { id:'B2', kick:1140, minExitSpeed:1325 },
  { id:'B3', kick:1040, minExitSpeed:1225 },
];

test('V129 pop bumpers use strong active-solenoid impulse values',()=>{
  for(const b of bumpers){
    assert.ok(b.kick >= 1000, `${b.id} kick should be at least 1000`);
    assert.ok(b.minExitSpeed >= 1200, `${b.id} should guarantee a fast outward launch`);
    assert.match(js,new RegExp(`id: '${b.id}'.*kick: ${b.kick}.*minExitSpeed: ${b.minExitSpeed}`,'u'));
  }
});

test('V129 guarantees minimum outward speed after a pop hit',()=>{
  assert.match(js,/const outward=ball\.vx\*nx\+ball\.vy\*ny;const minimum=c\.minExitSpeed\|\|0;/u);
  assert.match(js,/if\(outward<minimum\)\{const boost=minimum-outward;ball\.vx\+=nx\*boost;ball\.vy\+=ny\*boost;\}/u);
});

test('V129 makes bumper feedback visibly and audibly punchier',()=>{
  assert.match(js,/burst\(c\.x,c\.y,c\.color,28,680\)/u);
  assert.match(js,/state\.cameraShake=Math\.max\(state\.cameraShake,8\)/u);
  assert.match(js,/haptic\('medium'\)/u);
});

test('V129 cache-busts pinball assets',()=>{
  assert.match(html,/pinball\.css\?v=129/u);
  assert.match(html,/pinball\.js\?v=129/u);
});
