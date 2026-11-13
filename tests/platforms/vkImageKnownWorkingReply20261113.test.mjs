import test from 'node:test';
import assert from 'node:assert/strict';
import {sendDeferredVkPhotoMessage} from '../../src/platforms/vk/vkImageDeferredDelivery.js';
import {buildVkConversationReplySendParams} from '../../src/features/ai/vkImageEditReplyTransport.js';
import {retryVkPhotoUpload} from '../../src/platforms/vk/vkPhotoUploadRecovery.js';
const job={peer_id:2000000006,original_cmid:221550,random_id:872414,caption:'🎨 восстановленная картинка'};
const photo='photo755496806_457241474_4f4b736346be6471d1';
test('deferred photo uses EXACT existing working VK image reply params',async()=>{
 const sent=[];const client={api:{messages:{send:async payload=>{sent.push({...payload});return 8271;}}}};
 await sendDeferredVkPhotoMessage({client,job,attachment:photo});
 assert.equal(sent.length,1);
 const expected=buildVkConversationReplySendParams({peerId:job.peer_id,conversationMessageId:job.original_cmid,randomId:job.random_id,message:job.caption,attachment:photo});
 assert.deepEqual(sent[0],expected);assert.equal('reply_to' in sent[0],false);
 assert.deepEqual(JSON.parse(sent[0].forward),{peer_id:job.peer_id,conversation_message_ids:[221550],is_reply:true});
});
test('global message ID zero does not stop reply by local CMID',async()=>{
 let count=0;const client={api:{messages:{send:async p=>{count++;assert.deepEqual(JSON.parse(p.forward).conversation_message_ids,[221550]);return 7;}}}};
 await sendDeferredVkPhotoMessage({client,job,attachment:photo});assert.equal(count,1);
});
test('deleted original message falls back to plain photo only on VK code 100',async()=>{
 const sent=[];const client={api:{messages:{send:async p=>{sent.push({...p});if(p.forward)throw Object.assign(new Error('forwarded message not found'),{code:100});return 9;}}}};
 await sendDeferredVkPhotoMessage({client,job,attachment:photo});
 assert.equal(sent.length,2);assert.equal('forward' in sent[1],false);
 assert.equal(sent[0].random_id,sent[1].random_id);assert.equal(sent[0].attachment,sent[1].attachment);
});
test('network timeout does not attempt another send or remove reply',async()=>{
 const sent=[];const client={api:{messages:{send:async p=>{sent.push(p);throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});}}}};
 await assert.rejects(()=>sendDeferredVkPhotoMessage({client,job,attachment:photo}),/timeout/);
 assert.equal(sent.length,1);assert.ok(sent[0].forward);
});
test('photo without reply target delivers normally',async()=>{
 const sent=[];const client={api:{messages:{send:async p=>{sent.push(p);return 11;}}}};
 await sendDeferredVkPhotoMessage({client,job:{...job,original_cmid:0},attachment:photo});
 assert.equal('forward' in sent[0],false);
});
test('same native upload retries 405 three times without an SDK call',async()=>{
 let n=0;const raw=Buffer.from('same saved PNG');
 const out=await retryVkPhotoUpload(async()=>{assert.equal(raw.toString(),'same saved PNG');n++;if(n<3)throw Object.assign(new Error('405'),{code:'VK_UPLOAD_HTTP_ERROR',status:405});return photo;},{delaysMs:[1,1],wait:async()=>{}});
 assert.equal(out,photo);assert.equal(n,3);
});
test('50 repeated simulated replies have correct VK reply JSON',async()=>{
 let n=0;const client={api:{messages:{send:async p=>{n++;assert.equal(JSON.parse(p.forward).is_reply,true);assert.deepEqual(JSON.parse(p.forward).conversation_message_ids,[221550]);return n;}}}};
 for(let i=1;i<=50;i++)await sendDeferredVkPhotoMessage({client,job:{...job,random_id:i},attachment:photo});
 assert.equal(n,50);
});
