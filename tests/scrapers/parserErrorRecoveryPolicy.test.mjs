import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
import {classifyParserError,recoveryPostUrl,prepareRecoveryPage,captureRecoveryPosts} from '../../src/features/scrapers/parserErrorRecoveryPolicy.js';
import {parsePublicPostLocallyAsync} from '../../src/features/scrapers/parserWorkAsync.js';
test('classification and source-only URLs',()=>{
 assert.equal(classifyParserError({error:'x could not be cloned.'}),'code');
 assert.equal(classifyParserError({stage:'capture'}),'capture');
 assert.equal(recoveryPostUrl({sourceUrl:'https://vk.ru/wall-123_4'}),'https://vk.ru/wall-123_4');
 assert.equal(recoveryPostUrl({sourceUrl:'https://sun.userapi.com/a.jpg'}),'');
 assert.equal(recoveryPostUrl({sourceUrl:'https://vk.ru/club123'}),'');
});
test('bounded reloads use 20-40 sec and carousel only two attempts',async()=>{
 let reloads=0;const waits=[];
 await prepareRecoveryPage({evaluate:async()=>({broken:true,count:2}),reload:async()=>reloads++},{sleep:async ms=>waits.push(ms),random:()=>0.5});
 assert.equal(reloads,1);assert.deepEqual(waits,[25000,30000,25000]);
});
test('capture deduplicates posts and staggers launches',async()=>{
 const waits=[],rows=[1,2,2].map(id=>({sourceUrl:'https://vk.ru/wall-1_'+id}));
 const result=await captureRecoveryPosts(rows,async url=>({sourceUrl:url}),{sleep:async ms=>waits.push(ms),random:()=>0});
 assert.equal(result.size,2);assert.deepEqual(waits,[5000]);
});
test('worker accepts posts containing runtime image callbacks',async()=>{
 const result=await parsePublicPostLocallyAsync({text:'',prepareImage:()=>{},nested:{callback:()=>{}}});
 assert.ok(Array.isArray(result));
});
test('syntax and awaited mapping regression',()=>{
 for(const file of ['src/app/botApplication.js','src/platforms/vk/vkPublicScraper.js','src/features/scrapers/scraperCommandRouting.js']){
 const r=spawnSync(process.execPath,['--check',file],{windowsHide:true,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }
 const source=readFileSync('src/platforms/vk/vkPublicScraper.js','utf8');
 assert.ok(source.includes('? (await parsePublicPostLocallyAsync({ text: enrichedPost.text'));
});

test('owner recovery commands retain their distinct modes',async()=>{
 const {parseScraperStartCommand}=await import('../../src/features/scrapers/scraperCommandRouting.js');
 assert.equal(parseScraperStartCommand('попытаться исправить ошибки').parserErrors,true);
 assert.equal(parseScraperStartCommand('перепарсить нескачанное').missingCapture,true);
});

test('posterless source is recoverable even under an unrelated code error',async()=>{
 const {needsParserCapture,buildPosterRecoveryCandidates}=await import('../../src/features/scrapers/parserErrorRecoveryPolicy.js');
 const [row]=buildPosterRecoveryCandidates([{
  sourceType:'vk',screenName:'literabar',postId:8847,rawText:'November',
  imageUrls:[],imageMedia:[{url:'image1'},{url:'image2'}],
  events:[{sourceUrl:'https://vk.ru/wall-135849070_8847'}],
 }],()=>false);
 assert.equal(row.itemId,'8847');assert.equal(row.sourceId,'vk:literabar');
 assert.deepEqual(row.item.imageUrls,['image1','image2']);
 const old={...row,error:'.map is not a function',item:{sourceUrl:row.sourceUrl}};
 assert.equal(needsParserCapture(old),false);
 assert.equal(needsParserCapture(old,new Set([row.sourceUrl])),true);
 assert.equal(needsParserCapture({...old,item:{...old.item,imageUrls:[],imageMedia:[{url:'image'}]}}),true);
 assert.equal(buildPosterRecoveryCandidates([{events:[{}]}],()=>true).length,0);
});
test('single dated image gets eight attempts and absent DOM images are not success',async()=>{
 let reloads=0;const waits=[];
 await prepareRecoveryPage({evaluate:async()=>({broken:false,count:0}),reload:async()=>reloads++},{
  expectedImageCount:1,hasAnnouncementDate:true,sleep:async ms=>waits.push(ms),random:()=>0,
 });
 assert.equal(reloads,7);
 assert.equal(waits.filter(ms=>ms===20000).length,7);
 assert.equal(waits.filter(ms=>ms===25000).length,8);
});
test('recovery waits for image load after reload before declaring success',async()=>{
 const calls=[];let attempts=0;
 await prepareRecoveryPage({
  evaluate:async()=>{calls.push('check');return {broken:attempts++===0,count:1};},
  reload:async()=>calls.push('reload'),
 },{sleep:async ms=>calls.push(ms),expectedImageCount:1,random:()=>1});
 assert.deepEqual(calls,[25000,'check',40000,'reload',25000,'check']);
});
