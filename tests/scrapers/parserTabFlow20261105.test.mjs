import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserImageCacheRecovery,recoverPostImagesInBrowser} from '../../src/features/scrapers/browserImageCacheRecovery.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const image='https://sun9-1.userapi.com/a.jpg';
const source='https://vk.ru/wall-1_2';
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'parser-tab-flow-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return {directory,cache:new Map()};}
test('third and fourth posts open on spacing gates while earlier tabs remain open',async t=>{
 const pending=[],delays=[],opened=[],finish=[];
 const requests=Array.from({length:4},(_,i)=>({sourceUrl:'https://vk.ru/wall-1_'+(i+2),imageUrl:image+'?'+i}));
 const prepare=createBrowserImageCacheRecovery({...fixture(t),requests,random:()=>0.5,
  sleep:ms=>new Promise(resolve=>{delays.push(ms);pending.push(resolve);}),
  recover:async({sourceUrl})=>{opened.push(sourceUrl);await new Promise(resolve=>finish.push(resolve));return [];}});
 const jobs=requests.map(r=>prepare(r.imageUrl).catch(e=>e.code));
 await tick();assert.equal(opened.length,1);
 for(let i=0;i<3;i++){assert.equal(pending.length,1);pending.shift()();await tick();assert.equal(opened.length,i+2);}
 assert.equal(finish.length,4);assert.deepEqual(delays,[10000,10000,10000]);
 for(const resolve of finish)resolve();
 assert.deepEqual(await Promise.all(jobs),Array(4).fill('BROWSER_IMAGE_UNAVAILABLE'));
});
test('VK aliases and later phases share a single attempted source within one raw cache',async t=>{
 const state=fixture(t);let calls=0;
 const options={...state,sleep:async()=>{},recover:async()=>{calls++;throw Error('Target page, context or browser has been closed');}};
 const one=createBrowserImageCacheRecovery({...options,requests:[{sourceUrl:source,imageUrl:image}]});
 const two=createBrowserImageCacheRecovery({...options,requests:[{sourceUrl:'https://vk.com/wall-1_2?x=1',imageUrl:image}]});
 await assert.rejects(one(image),{code:'BROWSER_IMAGE_UNAVAILABLE'});
 await assert.rejects(two(image),{code:'BROWSER_IMAGE_UNAVAILABLE'});
 assert.equal(calls,1);
 const next=createBrowserImageCacheRecovery({...options,cache:new Map(),requests:[{sourceUrl:source,imageUrl:image}]});
 await assert.rejects(next(image),{code:'BROWSER_IMAGE_UNAVAILABLE'});assert.equal(calls,2);
});
test('manual close retains downloaded image bytes without a final DOM or a reopen',async t=>{
 const state=fixture(t),page=new EventEmitter();let closed=false,calls=0;
 const buffer=Buffer.alloc(1024);buffer.set([0x89,0x50,0x4e,0x47]);buffer.writeUInt32BE(800,16);buffer.writeUInt32BE(600,20);
 page.isClosed=()=>closed;
 const prepare=createBrowserImageCacheRecovery({...state,requests:[{sourceUrl:source,imageUrl:image}],sleep:async()=>{},
  recover:options=>recoverPostImagesInBrowser({...options,review:async o=>{
   calls++;assert.equal(o.separateTab,true);assert.equal(o.beforeScrollWaitMs,25000);
   o.onPageCreated(page);
   page.emit('response',{ok:()=>true,url:()=>image,headers:()=>({'content-type':'image/png'}),body:async()=>buffer});
   await tick();o.onPageReady(page);closed=true;page.emit('close');
   return {browserClosedAfterDom:true};
  }})});
 assert.equal(await prepare(image),'data:image/png;base64,'+buffer.toString('base64'));
 assert.equal(await prepare(image),'data:image/png;base64,'+buffer.toString('base64'));assert.equal(calls,1);
});
test('close before media arrives stays unresolved and does not create replacement tabs',async t=>{
 let calls=0;
 const prepare=createBrowserImageCacheRecovery({...fixture(t),requests:[{sourceUrl:source,imageUrl:image}],sleep:async()=>{},
  recover:options=>recoverPostImagesInBrowser({...options,review:async()=>{calls++;return {browserClosedAfterDom:true};}})});
 for(let i=0;i<3;i++)await assert.rejects(prepare(image),{code:'BROWSER_IMAGE_UNAVAILABLE'});
 assert.equal(calls,1);
});
test('network interruption still retries and successful bytes are cached',async t=>{
 let calls=0;const buffer=Buffer.alloc(1024);
 const prepare=createBrowserImageCacheRecovery({...fixture(t),requests:[{sourceUrl:source,imageUrl:image}],sleep:async()=>{},
  recover:async()=>{if(++calls===1)throw Error('net::ERR_CONNECTION_RESET');return [{imageUrl:image,buffer,mimeType:'image/png'}];}});
 assert.match(await prepare(image),/^data:image/);assert.equal(calls,2);
});
test('both parser phases prefetch without the former two-worker gate; dwell is unchanged',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.doesNotMatch(app,/browserImageRecoveryLimiter/);
 assert.match(app,/if \(phasePass === 2\) \{\s*await Promise\.all\(visionRequests\.flatMap/);
 const browser=readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js',import.meta.url),'utf8');
 assert.match(browser,/EVENT_REVIEW_MINIMUM_OPEN_MS = 180_000/);
});

test('source response observer attaches before navigation without changing tab lifetime',async()=>{
 const {runInNewContext}=await import('node:vm');
 const sourceText=readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js',import.meta.url),'utf8');
 const code=sourceText.slice(sourceText.indexOf('export async function openScraperTab('),sourceText.indexOf('export async function openPinnedScraperPage(')).replace('export async function','async function');
 const steps=[];
 const page={goto:async()=>steps.push('navigate'),isClosed:()=>false,close:async()=>{},bringToFront:async()=>{}};
 const open=runInNewContext(code+'\nopenScraperTab',{
  DEFAULT_TIMEOUT_MS:90000,MANUAL_WAIT_MS:900000,BROWSER_TAB_MINIMUM_OPEN_MS:15000,
  getScraperBrowserContext:async()=>({newPage:async()=>{steps.push('new-tab');return page;}}),
  browserTabLifetime:{protectPage:(_page,minimum)=>{assert.equal(minimum,180000);steps.push('protect');}},
  attachManagedPage:()=>{},waitForManualAccess:async()=>{},waitForInitialScraperRender:async()=>{},
 });
 await open({url:'https://vk.ru/wall-1_2',minimumOpenMs:180000,onPageCreated:()=>steps.push('observe')});
 assert.deepEqual(steps,['new-tab','protect','observe','navigate']);
});
