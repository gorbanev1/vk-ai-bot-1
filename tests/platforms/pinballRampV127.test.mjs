import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const js = await readFile(new URL('../../miniapps/pinball/pinball.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../miniapps/pinball/index.html', import.meta.url), 'utf8');

const hypot = Math.hypot;
function tangent(p0,p1,p2,p3,t){
  const u=1-t;
  const dx=3*u*u*(p1.x-p0.x)+6*u*t*(p2.x-p1.x)+3*t*t*(p3.x-p2.x);
  const dy=3*u*u*(p1.y-p0.y)+6*u*t*(p2.y-p1.y)+3*t*t*(p3.y-p2.y);
  const len=hypot(dx,dy)||1;
  return {x:dx/len,y:dy/len};
}
const ramps={
  left:{p0:{x:165,y:700},p1:{x:190,y:330},p2:{x:525,y:230},p3:{x:690,y:610}},
  right:{p0:{x:695,y:745},p1:{x:735,y:360},p2:{x:450,y:230},p3:{x:245,y:610}},
};

test('V127 ramp exits preserve the physical curve tangent instead of reversing sideways',()=>{
  const l=tangent(...Object.values(ramps.left),1);
  const r=tangent(...Object.values(ramps.right),1);
  assert.ok(l.x>0 && l.y>0,'left ramp should release down-right along its end tangent');
  assert.ok(r.x<0 && r.y>0,'right ramp should release down-left along its end tangent');
  assert.match(js,/bezierTangent\(r\.p0,r\.p1,r\.p2,r\.p3,p\)/u);
  assert.match(js,/ball\.vx=tangent\.x\*r\.exitSpeed;ball\.vy=tangent\.y\*r\.exitSpeed/u);
  assert.doesNotMatch(js,/left: .*exit: \{ vx: -360, vy: 520 \}/u);
  assert.doesNotMatch(js,/right: .*exit: \{ vx: 380, vy: 500 \}/u);
});

test('V127 ramp mouths are one-way shots and reject descending recapture loops',()=>{
  assert.match(js,/const entrySpeed = ball\.vx\*entryTangent\.x \+ ball\.vy\*entryTangent\.y/u);
  assert.match(js,/if \(entrySpeed < 260 \|\| ball\.vy > -180\) return false/u);
  assert.match(js,/rampLockoutUntil/u);
  assert.match(js,/ball\.rampLockoutUntil=t\+850/u);
  for(const ramp of Object.values(ramps)){
    const t=tangent(ramp.p0,ramp.p1,ramp.p2,ramp.p3,0);
    const descending={vx:0,vy:650};
    const entrySpeed=descending.vx*t.x+descending.vy*t.y;
    assert.ok(entrySpeed<260,'a descending ball must not be accepted by a ramp mouth');
    const upward={vx:0,vy:-650};
    const upwardSpeed=upward.vx*t.x+upward.vy*t.y;
    assert.ok(upwardSpeed>260,'a deliberate up-table shot should enter the ramp');
  }
});

test('V127 ramp release is nudged clear of the dashed endpoint before normal collisions resume',()=>{
  assert.match(js,/ball\.x\+=tangent\.x\*\(ball\.r\+12\);ball\.y\+=tangent\.y\*\(ball\.r\+12\)/u);
  assert.match(js,/ball\.sensorInside\.clear\(\)/u);
});

test('V127 cache-busts the repaired pinball client',()=>{
  assert.match(html,/pinball\.css\?v=12[7-9]/u);
  assert.match(html,/pinball\.js\?v=12[7-9]/u);
});
