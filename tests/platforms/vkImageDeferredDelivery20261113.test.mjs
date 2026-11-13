import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {
 createVkImageDeferredDelivery,deliverDueVkImages,
 VK_IMAGE_FALLBACK_METHODS,VK_IMAGE_ATTEMPTS_PER_METHOD,
 VK_IMAGE_BETWEEN_METHOD_ATTEMPTS_MS,VK_IMAGE_BETWEEN_ROUNDS_MS,VK_IMAGE_MAX_ATTEMPTS,
 vkImageFallbackStep,vkImageFallbackDelayAfter
} from '../../src/platforms/vk/vkImageDeferredDelivery.js';

async function scenario(fn,{legacy=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'gigorave-image-3round-'));
 const databasePath=join(dir,'delivery.sqlite'),clock={value:1800000000000};
 const now=()=>clock.value;
 if(legacy){
  const old=new DatabaseSync(databasePath);
  old.exec("CREATE TABLE vk_image_deferred_delivery(id TEXT PRIMARY KEY,peer_id INTEGER NOT NULL,original_cmid INTEGER NOT NULL,file_path TEXT NOT NULL,mime_type TEXT NOT NULL,filename TEXT NOT NULL,caption TEXT NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL,next_at INTEGER NOT NULL,attachment TEXT NOT NULL,random_id INTEGER NOT NULL,last_error TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  old.prepare("INSERT INTO vk_image_deferred_delivery VALUES('legacy',2000000008,514,'C:/test/old.png','image/png','old.png','old photo','pending',3,9999999999999,'',77334,'',123,123)").run();
  old.close();
 }
 let store=createVkImageDeferredDelivery({databasePath,now});
 const ctl={
  get queue(){return store},
  clock,
  advance:ms=>{clock.value+=ms},
  reopen:()=>{store.close();store=createVkImageDeferredDelivery({databasePath,now});return store}
 };
 try{await fn(ctl)}finally{try{store.close()}catch{}rmSync(dir,{recursive:true,force:true})}
}
const queueImage=q=>q.enqueue({peerId:2000000008,originalCmid:514,filePath:'C:/test/saved.png',filename:'saved.png'});
const io=q=>({queue:q,readImage:()=>Buffer.from('image-bytes'),isValidImage:()=>true});

test('exact 3 methods x 2 attempts x 3 rounds, with 1 min / 10 min / 15 min delays',async()=>scenario(async c=>{
 assert.deepEqual(VK_IMAGE_FALLBACK_METHODS,['native-direct','native-fresh-server','vk-io-sdk']);
 assert.deepEqual(VK_IMAGE_BETWEEN_ROUNDS_MS,[600000,900000]);
 assert.equal(VK_IMAGE_ATTEMPTS_PER_METHOD,2);
 assert.equal(VK_IMAGE_BETWEEN_METHOD_ATTEMPTS_MS,60000);
 assert.equal(VK_IMAGE_MAX_ATTEMPTS,18);
 const id=queueImage(c.queue).id,called=[],events=[];
 for(let i=0;i<18;i++){
  const before=c.queue.get(id);
  if(before.next_at>c.clock.value)c.advance(before.next_at-c.clock.value);
  assert.equal(await deliverDueVkImages({...io(c.queue),upload:async(job,buffer,method)=>{
   assert.equal(buffer.toString(),'image-bytes');called.push(method);throw new Error('VK unavailable');
  },send:async()=>assert.fail('Never send without photo'),onEvent:e=>events.push(e)}),1);
  const state=c.queue.get(id);
  assert.equal(state.attempt,i+1,'step '+i);
  assert.equal(state.status,i===17?'failed':'pending');
  const expected=vkImageFallbackDelayAfter(i);
  assert.equal(expected===null?0:expected,i===17?0:state.next_at-c.clock.value,'next gap after '+i);
 }
 assert.deepEqual(called,Array.from({length:3},()=>['native-direct','native-direct','native-fresh-server','native-fresh-server','vk-io-sdk','vk-io-sdk']).flat());
 assert.equal(events.filter(e=>e.event==='failed').length,1);
 assert.equal(events.at(-1).attempt,18);
 c.advance(99999999);
 assert.equal(await deliverDueVkImages({...io(c.queue),upload:async()=>assert.fail('No 19th attempt'),send:async()=>{}}),0);
}));
test('each method gets exactly a minute between its two tries',()=>{
 for(let i=0;i<18;i++){
  const s=vkImageFallbackStep(i);
  assert.equal(s.round,Math.floor(i/6)+1);
  if(i%2===0)assert.equal(vkImageFallbackDelayAfter(i),60000);
  if(i===5)assert.equal(vkImageFallbackDelayAfter(i),600000);
  if(i===11)assert.equal(vkImageFallbackDelayAfter(i),900000);
 }
});
test('success on the first attempt stops every method and later round; VK 0 is success',async()=>scenario(async c=>{
 const id=queueImage(c.queue).id;let uploads=0,sends=0;
 const use=()=>deliverDueVkImages({...io(c.queue),upload:async()=>{uploads++;return 'photo755496806_123'},send:async()=>{sends++;return 0;}});
 assert.equal(await use(),1);
 assert.equal(c.queue.get(id).status,'delivered');
 c.advance(200000000);assert.equal(await use(),0);
 assert.equal(uploads,1);assert.equal(sends,1);
}));
test('success on the 18th try stops and leaves no new retries',async()=>scenario(async c=>{
 const id=queueImage(c.queue).id,all=[];let sends=0;
 for(let i=0;i<18;i++){
  const row=c.queue.get(id);if(row.next_at>c.clock.value)c.advance(row.next_at-c.clock.value);
  await deliverDueVkImages({...io(c.queue),upload:async(job,buf,method)=>{
   all.push(method);
   if(i<17)throw new Error('upload failure');
   return 'photo755496806_124';
  },send:async()=>{sends++;return 0;}});
 }
 assert.equal(c.queue.get(id).status,'delivered');
 assert.equal(c.queue.get(id).attempt,17);
 assert.equal(all.length,18);assert.equal(sends,1);
 c.advance(1200000);assert.equal(c.queue.claimDue().length,0);
}));
test('after VK send failure reuse saved attachment and stable random_id, without another upload',async()=>scenario(async c=>{
 const id=queueImage(c.queue).id,randomIds=[];let uploads=0;
 const job=c.queue.get(id);
 await deliverDueVkImages({...io(c.queue),upload:async()=>{uploads++;return 'photo755496806_125'},send:async x=>{randomIds.push(x.random_id);throw new Error('VK send timeout')}});
 assert.equal(c.queue.get(id).attachment,'photo755496806_125');
 c.advance(60000);c.reopen();
 await deliverDueVkImages({...io(c.queue),upload:async()=>{uploads++;throw new Error('Should reuse photo')},send:async x=>{randomIds.push(x.random_id);return 0}});
 assert.equal(c.queue.get(id).status,'delivered');
 assert.equal(uploads,1);assert.deepEqual(randomIds,[job.random_id,job.random_id]);
}));
test('pre-uploaded attachment from failed initial context.send is queued for reply-only recovery',async()=>scenario(async c=>{
 const job=c.queue.enqueue({peerId:2000000008,originalCmid:514,filePath:'C:/test/already-uploaded.png',attachment:'photo755496806_126'});
 let sent=0;
 await deliverDueVkImages({...io(c.queue),upload:async()=>assert.fail('Never upload ready photo'),send:async(row,attachment)=>{sent++;assert.equal(attachment,'photo755496806_126');return 0}});
 assert.equal(c.queue.get(job.id).status,'delivered');assert.equal(sent,1);
}));
test('crash recovery retains same step, original reply target, random_id and attachment',async()=>scenario(async c=>{
 const job=c.queue.enqueue({peerId:2000000008,originalCmid:514,filePath:'C:/test/recover.png',attachment:'photo755496806_126'});
 const claimed=c.queue.claimDue();assert.equal(claimed.length,1);
 assert.equal(c.queue.get(job.id).status,'processing');
 const next=c.reopen().get(job.id);
 assert.equal(next.status,'pending');assert.equal(next.attempt,0);
 assert.equal(next.random_id,claimed[0].random_id);assert.equal(next.attachment,'photo755496806_126');
 assert.equal(next.original_cmid,514);
}));
test('legacy pending job migrates from obsolete timing to immediate 18-attempt plan',async()=>scenario(async c=>{
 const row=c.queue.get('legacy');
 assert.equal(row.status,'pending');assert.equal(row.pipeline_version,2);
 assert.equal(row.attempt,0);assert.equal(row.next_at,c.clock.value);
 const old=c.queue.claimDue();assert.equal(old.length,1);
 assert.equal(old[0].id,'legacy');
},{legacy:true}));
test('bad VK attachment code 100 allows re-upload through next verified method',async()=>scenario(async c=>{
 const job=c.queue.enqueue({peerId:2000000008,filePath:'C:/test/fallback.png',attachment:'photo755496806_126'});
 await deliverDueVkImages({...io(c.queue),upload:async()=>assert.fail('Already uploaded'),send:async()=>{throw Object.assign(new Error('invalid photo attachment'),{code:100})}});
 assert.equal(c.queue.get(job.id).attachment,'');
 c.advance(60000);
 let name='';
 await deliverDueVkImages({...io(c.queue),upload:async(row,buf,method)=>{name=method;return 'photo755496806_127'},send:async()=>0});
 assert.equal(name,'native-direct');assert.equal(c.queue.get(job.id).status,'delivered');
}));
test('wrong chat and invalid attachment are rejected, without overwriting an existing job',async()=>scenario(async c=>{
 assert.throws(()=>c.queue.enqueue({peerId:1,filePath:'C:/image.png'}),/group chat/);
 assert.throws(()=>c.queue.enqueue({peerId:2000000008,filePath:'C:/image.exe'}),/invalid/);
 assert.throws(()=>c.queue.enqueue({peerId:2000000008,filePath:'C:/image.png',attachment:'garbage'}),/attachment/);
 assert.equal(c.queue.stats().length,0);
}));
test('application has 3 methods and no obsolete nested image retry timing',()=>{
 const code=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(code,/method==='vk-io-sdk'/);
 assert.match(code,/return uploadVkMessagePhotoDirect\(\{/);
 assert.match(code,/const attachment=await uploadVkMessagePhotoDirect\(\{/);
 assert.match(code,/sendGeneratedVkImageWithFallback/);
 assert.match(code,/onDelivered:job=>/);
 assert.doesNotMatch(code,/delays=1,5,10,20-min/);
 assert.doesNotMatch(code,/retryVkPhotoUpload\(/);
});
