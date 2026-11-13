import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserImageCacheRecovery,recoverPostImagesInBrowser} from '../../src/features/scrapers/browserImageCacheRecovery.js';
import {applyPosterGateResult,allowTextOnlyAfterImageSkip} from '../../src/features/scrapers/posterGateResult.js';
const sourceUrl='https://vk.ru/wall-1_2';
test('closed pages have a shared maximum of 2 carousel / 8 single dated / 5 ordinary attempts',async t=>{
 for(const [count,dated,expected] of [[2,true,2],[1,true,8],[1,false,5]]){
  const directory=mkdtempSync(join(tmpdir(),'image-retry-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let calls=0;const delays=[];
  const requests=Array.from({length:count},(_,i)=>({sourceUrl,imageUrl:'https://cdn.example/'+i+'.jpg',hasAnnouncementDate:dated,sourceImageCount:count}));
  const prepare=createBrowserImageCacheRecovery({cache:new Map(),directory,requests,sleep:async ms=>delays.push(ms),random:()=>0.5,
   recover:async()=>{calls++;throw Object.assign(Error('closed'),{code:'BROWSER_IMAGE_RECOVERY_INTERRUPTED'});}});
  for(const request of requests)await assert.rejects(prepare(request.imageUrl),{code:'BROWSER_IMAGE_UNAVAILABLE'});
  assert.equal(calls,expected);assert.ok(delays.every(ms=>ms>=5000&&ms<=10000));
 }
});
test('missing carousel DOM reopens only the source once and then returns without media',async()=>{
 const page=new EventEmitter(), navigations=[],delays=[];
 page.evaluate=async()=>[];page.goto=async url=>navigations.push(url);
 const recovered=await recoverPostImagesInBrowser({sourceUrl,images:[{imageUrl:'https://cdn.example/1.jpg'},{imageUrl:'https://cdn.example/2.jpg'}],
  sleep:async ms=>delays.push(ms),random:()=>0,
  review:async o=>{o.onPageReady(page);await o.onFinalSnapshot({page,snapshot:{}});}});
 assert.deepEqual(recovered,[]);assert.deepEqual(navigations,[sourceUrl]);assert.deepEqual(delays,[5000,25000]);
});
test('image/CDN URLs are never used as a recovery page',async()=>{
 for(const url of ['https://sun9-1.userapi.com/photo','https://vk.ru/photo-1_2','https://cdn.example/photo.jpg'])
  await assert.rejects(recoverPostImagesInBrowser({sourceUrl:url,images:[],review:()=>assert.fail('naked image opened')}),{code:'BROWSER_IMAGE_UNAVAILABLE'});
});
test('skip remaps surviving image facts and allows text analysis without claiming Vision approval',()=>{
 const item={imageUrls:['bad','good']};
 applyPosterGateResult(item,{attempted:true,facts:'[IMAGE 2]\nposter',inspectedImageUrls:['bad','good'],inspectedImageIndexes:[1,2],skippedImageUrls:['bad']});
 assert.deepEqual(item.imageUrls,['good']);assert.match(item.__posterGateFacts,/\[IMAGE 1\]/);assert.equal(item.__posterGateError,'');
 const gate={attempted:true,skippedImageUrls:['bad']},text={visionEligible:true};
 assert.equal(allowTextOnlyAfterImageSkip({imageUrls:[]},gate,text),true);
 assert.equal(allowTextOnlyAfterImageSkip({imageUrls:[]},{...gate,error:'AI failed'},text),false);
 assert.equal(allowTextOnlyAfterImageSkip({imageUrls:[]},gate,{visionEligible:false}),false);
});
