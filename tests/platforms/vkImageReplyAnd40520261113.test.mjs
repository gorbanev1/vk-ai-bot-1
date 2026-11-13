import test from 'node:test';
import assert from 'node:assert/strict';
import {retryVkPhotoUpload,isRetryableVkPhotoUpload} from '../../src/platforms/vk/vkPhotoUploadRecovery.js';
import {sendDeferredVkPhotoMessage} from '../../src/platforms/vk/vkImageDeferredDelivery.js';
const job={peer_id:2000000032,original_cmid:42,random_id:1234571,caption:'тест VK'};
test('HTTP 405 retries the SAME native transport instead of switching immediately',async()=>{
 let tries=0;
 const got=await retryVkPhotoUpload(async()=>{tries++;if(tries<3)throw Object.assign(new Error('405'),{code:'VK_UPLOAD_HTTP_ERROR',status:405});return 'photo123_456'},
 {delaysMs:[1,1],wait:async()=>{}});
 assert.equal(got,'photo123_456');assert.equal(tries,3);
 assert.equal(isRetryableVkPhotoUpload({status:405,code:'VK_UPLOAD_HTTP_ERROR'}),true);
 assert.equal(isRetryableVkPhotoUpload({status:400,code:'VK_UPLOAD_HTTP_ERROR'}),false);
});
test('reply uses working VK CMID forward transport',async()=>{
 const sent=[];const client={api:{messages:{send:async p=>{sent.push({...p});return 2;}}}};
 await sendDeferredVkPhotoMessage({client,job,attachment:'photo123_456'});
 assert.deepEqual(JSON.parse(sent[0].forward),{peer_id:job.peer_id,conversation_message_ids:[42],is_reply:true});
 assert.equal('reply_to' in sent[0],false);
});
test('unavailable CMID delivers photo without reply',async()=>{
 const sent=[];const client={api:{messages:{send:async p=>{sent.push({...p});return 2;}}}};
 await sendDeferredVkPhotoMessage({client,job:{...job,original_cmid:0},attachment:'photo123_456'});
 assert.equal('forward' in sent[0],false);
});
test('code 100 on old reply allows fallback without reply',async()=>{
 const sent=[];const client={api:{messages:{send:async p=>{sent.push({...p});if(p.forward)throw Object.assign(new Error('forwarded message not found'),{code:100});return 2;}}}};
 await sendDeferredVkPhotoMessage({client,job,attachment:'photo123_456'});
 assert.equal(sent.length,2);assert.equal('forward' in sent[1],false);
 assert.equal(sent[0].random_id,sent[1].random_id);
});
