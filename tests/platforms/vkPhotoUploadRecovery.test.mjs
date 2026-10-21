import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetryableVkPhotoUpload, parseVkPhotoUploadResponse, retryVkPhotoUpload } from '../../src/platforms/vk/vkPhotoUploadRecovery.js';

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
