import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const js = await readFile(new URL('../../miniapps/pinball/pinball.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../miniapps/pinball/index.html', import.meta.url), 'utf8');

const bumpers = [
  { x:225, y:455, r:42 },
  { x:635, y:520, r:44 },
  { x:235, y:735, r:40 },
];
const targets = [
  { id:'R', x1:120, y1:900, x2:205, y2:875 },
  { id:'A', x1:135, y1:1015, x2:220, y2:990 },
  { id:'V', x1:590, y1:990, x2:675, y2:1015 },
  { id:'E', x1:605, y1:875, x2:690, y2:900 },
];
const ramps = {
  left: [{x:135,y:720},{x:95,y:555},{x:140,y:440},{x:340,y:610}],
  right: [{x:705,y:760},{x:735,y:600},{x:690,y:470},{x:560,y:650}],
};

function bezier(p0,p1,p2,p3,t){const u=1-t,tt=t*t,uu=u*u;return{x:uu*u*p0.x+3*uu*t*p1.x+3*u*tt*p2.x+tt*t*p3.x,y:uu*u*p0.y+3*uu*t*p1.y+3*u*tt*p2.y+tt*t*p3.y};}

test('V128 leaves a broad central travel corridor instead of a bumper cluster',()=>{
  for(const b of bumpers){
    assert.ok(b.x+b.r < 330 || b.x-b.r > 570, `bumper at ${b.x},${b.y} must stay out of x=330..570 corridor`);
  }
  assert.equal(bumpers.length,3,'wide layout deliberately uses three pop bumpers');
  assert.match(js,/clear central corridor is kept open/u);
  assert.doesNotMatch(js,/id: 'B4'/u);
});

test('V128 splits RAVE targets into left and right banks',()=>{
  for(const t of targets.slice(0,2)) assert.ok(Math.max(t.x1,t.x2)<230,`${t.id} must stay on left bank`);
  for(const t of targets.slice(2)) assert.ok(Math.min(t.x1,t.x2)>580,`${t.id} must stay on right bank`);
  assert.match(js,/two separate side banks/u);
});

test('V128 dashed ramps stay on their own sides and do not cross the center',()=>{
  for(let i=0;i<=80;i+=1){
    const l=bezier(...ramps.left,i/80);
    const r=bezier(...ramps.right,i/80);
    assert.ok(l.x<=345,`left ramp intrudes into center at x=${l.x}`);
    assert.ok(r.x>=555,`right ramp intrudes into center at x=${r.x}`);
  }
});

test('V128 removes the extra upper flipper and decorative center rails',()=>{
  assert.doesNotMatch(js,/id: 'U'/u);
  assert.doesNotMatch(js,/Small center rails/u);
  assert.match(js,/Conventional two-flipper bottom/u);
});

test('V128 moves the scoop below the open mid-field and cache-busts assets',()=>{
  assert.match(js,/const SCOOP = Object\.freeze\(\{ x: 450, y: 1080, r: 40 \}\)/u);
  assert.match(html,/pinball\.css\?v=12\d/u);
  assert.match(html,/pinball\.js\?v=12\d/u);
});
