import test from 'node:test';import assert from 'node:assert/strict';
import {createReplayPosterGate} from '../../src/features/scrapers/parserReplayPosterGate.js';
test('replay runs awaited Vision admission with original image indexes',async()=>{
 let called=0;const gate=createReplayPosterGate({prepareImage:async()=>({bytes:'cache'}),
 extract:async request=>{called++;assert.deepEqual(request.imageIndexes,[2]);assert.equal(request.browserCacheOnly,true);await request.prepareImage('b');return 'poster facts';}});
 await gate.onCapture({sourceId:'vk:test',posterGateRequests:[{itemId:1,imageUrls:['b'],originalImageUrls:['a','b']}]});
 assert.equal(called,1);assert.equal(gate.getResult('vk:test',1).attempted,true);assert.equal(gate.getResult('vk:test',1).facts,'poster facts');
 assert.equal(gate.getResult('vk:other',1),null);
});
test('failure retains partial facts and explicit error, skip remains available to text fallback',async()=>{
 const gate=createReplayPosterGate({prepareImage:()=>{},extract:async r=>{
 r.trace('image_skipped',{imageUrl:'b'});throw Object.assign(Error('unavailable'),{partialFacts:'partial'});
 }});
 await gate.onCapture({sourceId:'vk:test',posterGateRequests:[{itemId:2,imageUrls:['a','b']}]});
 const result=gate.getResult('vk:test',2);
 assert.equal(result.error,'unavailable');assert.equal(result.facts,'partial');assert.deepEqual(result.skippedImageUrls,['b']);
});

test('replay offers cached facts with source identity and retains admission policy',async()=>{
 let found;
 const gate=createReplayPosterGate({prepareImage:()=>{},getCachedImageFact:(request,number,url)=>{
  found={request,number,url};return 'cached';
 },extract:async options=>{
  assert.equal(options.secondaryJointGate,true);assert.equal(options.dateFreePhase,true);
  return options.getCachedImageFact(2,'b');
 }});
 await gate.onCapture({sourceId:'vk:test',posterGateRequests:[{
  itemId:2,imageUrls:['b'],originalImageUrls:['a','b'],sourceText:'same',
  secondaryJointGate:true,visionPhase:'phase2-date-free-image',
 }]});
 assert.equal(found.request.sourceId,'vk:test');assert.equal(found.number,2);
 assert.equal(gate.getResult('vk:test',2).facts,'cached');
});
