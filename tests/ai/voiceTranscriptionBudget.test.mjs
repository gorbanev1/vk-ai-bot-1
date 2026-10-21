import assert from 'node:assert/strict';
import test from 'node:test';
import { transcribeAudioBuffer } from '../../src/features/ai/voiceTranscription.js';
import { resetRuntimeModelCredentialHealth } from '../../src/features/ai/modelProviderFailover.js';

const providers = [{ name: 'test-budget', apiKey: 'test', baseUrl: 'https://stt.test', models: ['whisper-1'] }];
const input = { buffer: Buffer.from('audio'), providers };

test('STT ends after three failures without another recovery round', async () => {
    resetRuntimeModelCredentialHealth();
    const prior = process.env.AI_KEY_RETRY_BASE_MS;
    process.env.AI_KEY_RETRY_BASE_MS = '1';
    let calls = 0;
    try {
        await assert.rejects(() => transcribeAudioBuffer({ ...input, fetchImpl: async () => {
            calls++;
            return new Response('unavailable', { status: 503 });
        } }), error => error.status === 503);
        assert.equal(calls, 3);
    } finally {
        if (prior === undefined) delete process.env.AI_KEY_RETRY_BASE_MS;
        else process.env.AI_KEY_RETRY_BASE_MS = prior;
    }
});

test('STT total budget aborts a hanging fetch', async () => {
    resetRuntimeModelCredentialHealth();
    let calls = 0;
    // AbortSignal.timeout is unrefed; keep a handle alive as a real socket would.
    const keepAlive = setInterval(() => {}, 1000);
    try {
        await assert.rejects(() => transcribeAudioBuffer({ ...input, totalTimeoutMs: 30,
            fetchImpl: async (_url, { signal }) => {
                calls++;
                return new Promise((_, reject) => {
                    if (signal.aborted) reject(signal.reason);
                    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            },
        }), { name: 'TimeoutError' });
        assert.equal(calls, 1);
    } finally { clearInterval(keepAlive); }
});

test('STT cancelled before dispatch sends no request', async () => {
    let calls = 0;
    await assert.rejects(() => transcribeAudioBuffer({ ...input, signal: AbortSignal.abort(),
        fetchImpl: async () => { calls++; },
    }), { name: 'AbortError' });
    assert.equal(calls, 0);
});

test('STT does not accept error JSON as a successful transcript', async () => {
    resetRuntimeModelCredentialHealth();
    await assert.rejects(() => transcribeAudioBuffer({ ...input,
        fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'no transcript' } })),
    }), /no transcript/);
});
