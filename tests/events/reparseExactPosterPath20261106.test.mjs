
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const s=fs.readFileSync(new URL('../../src/infrastructure/database/index.js',import.meta.url),'utf8');
const start=s.indexOf('function resolveSafeReparsePosterPath('),end=s.indexOf('\nexport function ',start);
function resolver(gallery){
 return vm.runInNewContext('('+s.slice(start,end).trim()+')',{
  storedPosterStatusIsSafe:()=>true,posterFactForIndex:(facts,i)=>facts.find(f=>f.index===i),
  database:{prepare:()=>({get:()=>({image_paths_json:JSON.stringify(gallery)})})},
  parseStoredImagePaths:JSON.parse,legacyCapturedMediaIndex:p=>Number(p.split('/').at(-1).split('-')[1].split('.')[0])
 });
}
test('archive recovery retains the exact hash-suffixed file used by Vision',()=>{
 const fn=resolver(['vk_announcements/rb_diesel/14011-2.jpg']);
 const bound='vk_announcements/rb_diesel/14011-2-4205e9f5babc.jpg';
 assert.equal(fn('vk_events',{}, {posterImageIndex:2,posterVisionFacts:[{index:2,imagePath:bound}]}),bound);
});
test('legacy unbound facts still resolve their source gallery index',()=>{
 const fn=resolver(['vk_announcements/rb_diesel/14011-2.jpg']);
 assert.equal(fn('vk_events',{}, {posterImageIndex:2,posterVisionFacts:[{index:2}]}),'vk_announcements/rb_diesel/14011-2.jpg');
});
test('different image indexes do not borrow another facts bound file',()=>{
 const fn=resolver(['vk_announcements/rb_diesel/14011-5.jpg']);
 assert.equal(fn('vk_events',{}, {posterImageIndex:5,posterVisionFacts:[{index:2,imagePath:'wrong.jpg'}]}),'vk_announcements/rb_diesel/14011-5.jpg');
});
