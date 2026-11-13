import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runParserWorkTask } from '../../src/features/scrapers/parserWorkAsync.js';
import { createBrowserImageCacheRecovery } from '../../src/features/scrapers/browserImageCacheRecovery.js';

test('replay worker recovers archived image bytes and facts when original files were removed', async () => {
 const root=mkdtempSync(join(tmpdir(),'replay-evidence-'));
 try {
  const archive=join(root,'archive'),raw=join(archive,'raw-images');mkdirSync(raw,{recursive:true});
  writeFileSync(join(raw,'poster.image'),Buffer.from([1,2,3]));
  writeFileSync(join(raw,'manifest.json'),JSON.stringify([
   ['https://image/one',{path:join(root,'removed','poster.image'),byteLength:3,mimeType:'image/png'}],
   ['https://image/wrong',{path:join(root,'removed','poster.image'),byteLength:9}],
  ]));
  const cache=join(archive,'raw-cache.json'),trace=join(archive,'trace.jsonl');
  writeFileSync(cache,JSON.stringify({items:[
   {postId:7,sourceUrl:'https://vk.ru/wall-1_7',imageUrls:['https://image/one','https://image/wrong']},
   {postId:8,imageUrls:['unrelated']},
  ]}));
  writeFileSync(trace,[
   {stage:'item.poster-gate.batch_start',data:{sourceId:'vk:test',itemId:'7',sourceUrl:'https://vk.ru/wall-1_7',posterGatePolicyVersion:2}},
   {stage:'item.poster-gate.image',data:{sourceId:'vk:test',itemId:'7',imageNumber:1,imageUrl:'https://image/one',responseText:'facts'}},
  ].map(JSON.stringify).join('\n'));
  const evidence=await runParserWorkTask('load-replay-evidence',{rows:[{
   sourceId:'vk:test',itemId:'7',rawCachePath:join(root,'missing.json'),
   evidenceHistory:[{archiveDirectory:archive,rawCachePath:cache,tracePath:trace}],
  }]});
  assert.deepEqual([...evidence.itemsById.keys()],['7']);
  assert.equal(evidence.imageCache.size,1);
  assert.equal(evidence.posterGateImages.size,1);
  assert.equal(evidence.cacheErrors.length,1);
  let opened=0;
  const prepare=createBrowserImageCacheRecovery({cache:evidence.imageCache,requests:[],directory:raw,recover:async()=>{opened++;return [];}});
  assert.equal(await prepare('https://image/one'),'data:image/png;base64,AQID');
  assert.equal(opened,0);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('latest exact item wins over older archived cache',async()=>{
 const root=mkdtempSync(join(tmpdir(),'replay-latest-'));
 try{
  const current=join(root,'new.json'),old=join(root,'old.json');
  writeFileSync(current,JSON.stringify({items:[{postId:7,text:'new'}]}));
  writeFileSync(old,JSON.stringify({items:[{postId:7,text:'old'},{postId:8,text:'missing'}]}));
  const result=await runParserWorkTask('load-replay-evidence',{rows:[
   {sourceId:'vk:test',itemId:'7',rawCachePath:current,evidenceHistory:[{rawCachePath:old}]},
   {sourceId:'vk:test',itemId:'8',rawCachePath:current,evidenceHistory:[{rawCachePath:old}]},
  ]});
  assert.equal(result.itemsById.get('7').text,'new');
  assert.equal(result.itemsById.get('8').text,'missing');
 }finally{rmSync(root,{recursive:true,force:true});}
});
