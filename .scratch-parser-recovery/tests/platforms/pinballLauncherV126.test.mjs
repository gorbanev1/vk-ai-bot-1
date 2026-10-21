import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const js = await readFile(new URL('../../miniapps/pinball/pinball.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../miniapps/pinball/index.html', import.meta.url), 'utf8');

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const bezier=(p0,p1,p2,p3,t)=>{const u=1-t,tt=t*t,uu=u*u;return{x:uu*u*p0.x+3*uu*t*p1.x+3*u*tt*p2.x+tt*t*p3.x,y:uu*u*p0.y+3*uu*t*p1.y+3*u*tt*p2.y+tt*t*p3.y};};
const curves=[
  [{x:790,y:1475},{x:790,y:1000},{x:800,y:480},{x:760,y:265}],
  [{x:760,y:265},{x:738,y:175},{x:675,y:155},{x:585,y:350}],
];
function buildTrack(){const raw=[];for(let c=0;c<curves.length;c++){for(let i=0;i<=80;i++){if(c&&i===0)continue;raw.push(bezier(...curves[c],i/80));}}let s=0;return raw.map((p,i)=>{if(i)s+=Math.hypot(p.x-raw[i-1].x,p.y-raw[i-1].y);return{...p,s};});}
const track=buildTrack(); const total=track.at(-1).s;
function sample(s){s=clamp(s,0,total);let i=0;while(i+1<track.length&&track[i+1].s<s)i++;const a=track[i],b=track[Math.min(i+1,track.length-1)],ds=Math.max(.0001,b.s-a.s),q=clamp((s-a.s)/ds,0,1),dx=b.x-a.x,dy=b.y-a.y,l=Math.hypot(dx,dy)||1;return{x:a.x+(b.x-a.x)*q,y:a.y+(b.y-a.y)*q,tx:dx/l,ty:dy/l};}
function simulate(charge){let s=0,v=1640+700*charge;const dt=1/180;for(let step=0;step<1200;step++){const p=sample(s);let a=1080*p.ty;if(Math.abs(v)>1)a-=Math.sign(v)*55;v+=a*dt;s+=v*dt;if(s<=0&&v<=0)return{returned:true,step,s,v};if(s>=total)return{exited:true,step,s,v};}return{timeout:true,s,v};}

test('V126 models a real-style right shooter lane with rollback/re-plunge',()=>{
  assert.match(js,/const SHOOTER_TRACK_CURVES/u);
  assert.match(js,/function updateShooterMotion\(ball, dt\)/u);
  assert.match(js,/GRAVITY \* before\.ty/u);
  assert.match(js,/function resetShooterBall\(ball/u);
  assert.match(js,/BALL RETURNED · HOLD SPACE · RELEASE TO PLUNGE AGAIN/u);
  assert.match(js,/function captureShooterReturn\(ball\)/u);
});

test('V126 soft plunge returns, normal plunge clears the crest',()=>{
  assert.equal(simulate(0).returned,true,'zero-charge plunge should be allowed to roll back');
  assert.equal(simulate(.10).exited,true,'a short deliberate plunge should clear the shooter lane');
  for(let i=0;i<30;i+=1){
    const charge=.10+.90*(i/29);
    assert.equal(simulate(charge).exited,true,`launch ${i+1}/30 at charge ${charge.toFixed(3)} must clear`);
  }
  assert.equal(simulate(.50).exited,true);
  assert.equal(simulate(1).exited,true);
});

test('V126 release point is in open playfield, away from the old corner trap',()=>{
  const exit=sample(total);
  assert.ok(exit.x<620 && exit.y>320,'exit should be well inside the table');
  const oldCorner={x:675,y:255};
  assert.ok(Math.hypot(exit.x-oldCorner.x,exit.y-oldCorner.y)>120,'exit must not overlap old upper-right guide corner');
});

test('V126 replaces sharp launcher/cabinet joints with curved Bezier rails',()=>{
  assert.match(js,/function bezierWall\(/u);
  assert.doesNotMatch(js,/segment\(675, 80, 820, 235/u);
  assert.doesNotMatch(js,/segment\(750, 490, 750, 1505/u);
  assert.match(js,/Full-length right-side shooter lane/u);
});

test('V126 cache busts changed Mini App assets',()=>{
  assert.match(html,/pinball\.css\?v=12[6-9]/u);
  assert.match(html,/pinball\.js\?v=12[6-9]/u);
});
