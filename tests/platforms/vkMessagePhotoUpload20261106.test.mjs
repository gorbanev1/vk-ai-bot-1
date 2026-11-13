import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { uploadVkMessagePhotoOnce, vkPhotoAttachment } from '../../src/platforms/vk/vkMessagePhotoUpload.js';
import { retryVkPhotoUpload } from '../../src/platforms/vk/vkPhotoUploadRecovery.js';
const buffer = Buffer.from('retained-original-bytes');
function fixture({ replies = [{ server: 2, photo: '[{"id":3}]', hash: 'signature' }], saved = [{ owner_id: -123, id: 4, access_key: 'access_key' }] } = {}) {
    const servers=[], posts=[], saves=[], telemetry=[];
    const client={api:{photos:{
        getMessagesUploadServer:async params=>{servers.push(params);return {upload_url:`https://pu.vk.com/c${servers.length}/upload.php?hash=secret${servers.length}`};},
        saveMessagesPhoto:async params=>{saves.push(params);return saved;},
    }}};
    return {servers,posts,saves,telemetry,options:{client,buffer,filename:'summary.png',mimeType:'image/png',peerId:2000000027,
        onAttempt:e=>telemetry.push(e),fetchImpl:async(url,options)=>{posts.push({url,options});const reply=replies[Math.min(posts.length-1,replies.length-1)];return reply instanceof Response?reply:new Response(JSON.stringify(reply));},
    }};
}
test('successful upload sends actual peer, original bytes and saves attachment',async()=>{
    const f=fixture();const attachment=await uploadVkMessagePhotoOnce(f.options);
    assert.equal(attachment,'photo-123_4_access_key');assert.deepEqual(f.servers,[{peer_id:2000000027}]);
    const photo=f.posts[0].options.body.get('photo');assert.equal(photo.name,'summary.png');assert.equal(photo.type,'image/png');assert.deepEqual(Buffer.from(await photo.arrayBuffer()),buffer);
    assert.deepEqual(f.saves,[{server:2,photo:'[{"id":3}]',hash:'signature'}]);assert.doesNotMatch(JSON.stringify(f.telemetry),/secret|signature|access_key/u);
});
test('empty photo gets a new server for same recipient; never saves empty result',async()=>{
    const f=fixture({replies:[{server:856404,photo:'',hash:'bad'}, {server:858512,photo:'[{"id":3}]',hash:'good'}]});const waits=[];
    const result=await retryVkPhotoUpload(()=>uploadVkMessagePhotoOnce(f.options),{wait:async ms=>waits.push(ms)});
    assert.equal(result,'photo-123_4_access_key');assert.deepEqual(waits,[5000]);assert.equal(f.servers.length,2);assert.ok(f.servers.every(p=>p.peer_id===2000000027));assert.notEqual(f.posts[0].url,f.posts[1].url);assert.equal(f.saves.length,1);
});
test('HTML gateway reply retains status and retries a fresh upload URL',async()=>{
    const f=fixture({replies:[new Response('<html>gateway</html>',{status:502}),{server:9,photo:'x',hash:'h'}]});
    await retryVkPhotoUpload(()=>uploadVkMessagePhotoOnce(f.options),{wait:async()=>{}});assert.equal(f.posts.length,2);assert.equal(f.saves.length,1);assert.equal(f.telemetry[0].httpStatus,502);
});
test('HTTP200 HTML is a retryable protocol response, not success',async()=>{
    const f=fixture({replies:[new Response('<html>temporary failure</html>'),{server:9,photo:'x',hash:'h'}]});
    await retryVkPhotoUpload(()=>uploadVkMessagePhotoOnce(f.options),{wait:async()=>{}});assert.equal(f.posts.length,2);assert.equal(f.saves.length,1);
});
test('invalid credentials and bad requests do not retry forever',async()=>{
    const f=fixture({replies:[new Response('denied',{status:403})]});
    await assert.rejects(retryVkPhotoUpload(()=>uploadVkMessagePhotoOnce(f.options),{wait:async()=>assert.fail()}));assert.equal(f.posts.length,1);assert.equal(f.saves.length,0);
});
test('persistent empty photo exhausts existing three-attempt budget',async()=>{
    const f=fixture({replies:[{server:1,photo:'',hash:'h'}]});const waits=[];
    await assert.rejects(retryVkPhotoUpload(()=>uploadVkMessagePhotoOnce(f.options),{wait:async ms=>waits.push(ms)}),e=>e.code==='VK_UPLOAD_EMPTY_PHOTO');
    assert.equal(f.posts.length,3);assert.equal(f.saves.length,0);assert.deepEqual(waits,[5000,15000]);
});
test('aborted operation never uploads or saves',async()=>{
    const f=fixture();await assert.rejects(uploadVkMessagePhotoOnce({...f.options,signal:AbortSignal.abort()}));assert.equal(f.posts.length,0);assert.equal(f.saves.length,0);
});
test('diagnostic callback cannot fail a successfully saved photo',async()=>{
    const f=fixture();assert.equal(await uploadVkMessagePhotoOnce({...f.options,onAttempt:()=>{throw new Error('logger');}}),'photo-123_4_access_key');assert.equal(f.saves.length,1);
});
test('invalid saved metadata cannot produce NaN or zero attachment',async()=>{
    for(const saved of [[],{owner_id:0,id:3},{owner_id:1,id:0},{owner_id:1,id:NaN}])assert.equal(vkPhotoAttachment(saved),'');
    const f=fixture({saved:[]});await assert.rejects(uploadVkMessagePhotoOnce(f.options),e=>e.code==='VK_UPLOAD_SAVE_INVALID');
});
const source=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
function extract(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
test('generated images go directly through destination-aware transport, without sdk pre-attempt',async()=>{
    const calls=[], files=new Map();const sandbox=vm.createContext({Buffer,Number,String,Math,Date,console:{log(){},warn(){},error(){}},
        isValidOpenAIImageBuffer:()=>true,getRawContext:c=>c,detectImageMimeType:()=> 'image/png',resolve:(...x)=>x.join('/'),mkdirSync:()=>{},writeFileSync:(p,b)=>files.set(p,b),unlinkSync:p=>files.delete(p),
        getCurrentOperationSignal:()=>undefined,getActiveVkConnection:()=>({client:{}}),primaryVk:{},
        retryVkPhotoUpload:fn=>fn(),uploadVkPhotoWithSdk405Fallback:async direct=>direct(),uploadVkMessagePhotoDirect:async o=>{calls.push(o);return 'photo-1_2';},
    });
    vm.runInContext(extract('async function uploadGeneratedImageBuffer(', 'async function uploadOpenAIImage('),sandbox);
    sandbox.buffer=buffer;
    assert.equal(await vm.runInContext("uploadGeneratedImageBuffer({buffer,context:{platform:'vk',peerId:2000000027},basename:'image'})",sandbox),'photo-1_2');
    assert.equal(calls.length,1);assert.equal(calls[0].peerId,2000000027);assert.equal(calls[0].buffer,buffer);assert.equal(files.size,0);
});
test('scheduled summary passes its real destination to upload',()=>{
    const summary=extract('async function sendScheduledAutoSummary(', 'const autoSummaryImageJobs');
    assert.match(summary,/basename: 'auto-summary', vkClient: client, peerId/u);
});
