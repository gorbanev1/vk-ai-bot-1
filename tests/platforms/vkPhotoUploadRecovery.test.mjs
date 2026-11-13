import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetryableVkPhotoUpload, parseVkPhotoUploadResponse, retryVkPhotoUpload, uploadVkPhotoWithSdk405Fallback } from '../../src/platforms/vk/vkPhotoUploadRecovery.js';

test('VK HTML gateway response preserves HTTP status and is retryable', async () => {
    await assert.rejects(
        () => parseVkPhotoUploadResponse(new Response('<html>gateway</html>', { status: 502 })),
        (error) => error.status === 502 && error.code === 'VK_UPLOAD_HTTP_ERROR',
    );
    assert.equal(isRetryableVkPhotoUpload(Object.assign(new Error('gateway'), { status: 502 })), true);
});

test('VK upload retries transient failures and succeeds without regenerating image', async () => {
    let calls = 0;
    const waits = [];
    const value = await retryVkPhotoUpload(async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('bad gateway'), { status: 504 });
        return 'photo-1_2';
    }, { delaysMs: [1, 1], wait: async (ms) => waits.push(ms) });
    assert.equal(value, 'photo-1_2');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1, 1]);
});

test('VK 400 is not retried', async () => {
    let calls = 0;
    await assert.rejects(() => retryVkPhotoUpload(async () => {
        calls += 1;
        throw Object.assign(new Error('bad request'), { status: 400 });
    }, { delaysMs: [1], wait: async () => {} }));
    assert.equal(calls, 1);
});

test('VK persistent 504 exhausts three attempts; cancellation stops before upload', async () => {
    let calls = 0;
    await assert.rejects(() => retryVkPhotoUpload(async () => {
        calls++;
        throw Object.assign(new Error('gateway'), { status: 504 });
    }, { wait: async () => {} }), error => error.status === 504);
    assert.equal(calls, 3);
    await assert.rejects(() => retryVkPhotoUpload(async () => { calls++; }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(calls, 3);
});

test('HTTP 405 from native VK multipart is recovered by vk-io without regenerating the image',async()=>{
 const file=Buffer.from('already generated PNG');let direct=0,sdk=0,fallbacks=0;
 const result=await uploadVkPhotoWithSdk405Fallback(async()=>{direct++;throw Object.assign(new Error('Method Not Allowed'),{code:'VK_UPLOAD_HTTP_ERROR',status:405})},
  async()=>{sdk++;return 'photo68093009_457334665';},{onFallback:()=>{fallbacks++}});
 assert.equal(result,'photo68093009_457334665');
 assert.deepEqual({direct,sdk,fallbacks},{direct:1,sdk:1,fallbacks:1});
});
test('other HTTP failures do not trigger SDK fallback and original error propagates',async()=>{
 let sdk=0;for(const code of [400,403,502]){
  await assert.rejects(()=>uploadVkPhotoWithSdk405Fallback(
   async()=>{throw Object.assign(new Error('HTTP '+code),{code:'VK_UPLOAD_HTTP_ERROR',status:code})},
   async()=>{sdk++;return 'photo1_1'}),{status:code});
 }
 assert.equal(sdk,0);
});
test('SDK fallback failure is visible to normal stored-image fallback handler',async()=>{
 await assert.rejects(()=>uploadVkPhotoWithSdk405Fallback(
  async()=>{throw Object.assign(new Error('HTTP 405'),{code:'VK_UPLOAD_HTTP_ERROR',status:405})},
  async()=>{throw Object.assign(new Error('SDK also unavailable'),{code:'VK_SDK_UPLOAD_FAILED'})}),
  {code:'VK_SDK_UPLOAD_FAILED'});
});test('HTTP 405 plus SDK Not Allowed retries on a fresh native upload server',async()=>{
 let calls=0,sdkCalls=0;
 const result=await uploadVkPhotoWithSdk405Fallback(
  async()=>{calls++;throw Object.assign(new Error('upload 405'),{code:'VK_UPLOAD_HTTP_ERROR',status:405})},
  async()=>{sdkCalls++;throw new Error('Not Allowed')},
  {retryAfterSdkFailure:async err=>{assert.match(err.message,/Not Allowed/);calls++;return 'photo755496806_457241472';}}
 );
 assert.equal(result,'photo755496806_457241472');
 assert.deepEqual([calls,sdkCalls],[2,1]);
});
test('without fresh server retry the SDK error propagates',async()=>{
 await assert.rejects(uploadVkPhotoWithSdk405Fallback(
  async()=>{throw Object.assign(new Error('405'),{code:'VK_UPLOAD_HTTP_ERROR',status:405})},
  async()=>{throw new Error('Not Allowed')}
 ),/Not Allowed/);
});
