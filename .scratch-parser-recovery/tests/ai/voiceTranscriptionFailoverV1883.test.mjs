import assert from 'node:assert/strict';
import { transcribeAudioBuffer } from '../../src/features/ai/voiceTranscription.js';
import { resetRuntimeModelCredentialHealth } from '../../src/features/ai/modelProviderFailover.js';

const previousBase = process.env.AI_KEY_RETRY_BASE_MS;
const previousMax = process.env.AI_KEY_RETRY_MAX_MS;
process.env.AI_KEY_RETRY_BASE_MS = '1';
process.env.AI_KEY_RETRY_MAX_MS = '1';

try {
    resetRuntimeModelCredentialHealth();
    const calls = [];
    const result = await transcribeAudioBuffer({
        buffer: Buffer.from('voice-bytes'),
        providers: [
            {
                name: 'STT_KEY_1',
                baseUrl: 'https://stt-one.test/v1',
                apiKey: 'first',
                models: ['whisper-1'],
            },
            {
                name: 'STT_KEY_2',
                baseUrl: 'https://stt-two.test/v1',
                apiKey: 'second',
                models: ['whisper-1'],
            },
        ],
        fetchImpl: async (url) => {
            calls.push(String(url));
            if (String(url).includes('stt-one.test')) {
                return new Response(JSON.stringify({ error: { message: 'temporary unavailable' } }), {
                    status: 503,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ text: 'привет из второго ключа' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });

    assert.equal(result.text, 'привет из второго ключа');
    assert.equal(calls.filter((url) => url.includes('stt-one.test')).length, 3);
    assert.equal(calls.filter((url) => url.includes('stt-two.test')).length, 1);
} finally {
    if (previousBase === undefined) delete process.env.AI_KEY_RETRY_BASE_MS;
    else process.env.AI_KEY_RETRY_BASE_MS = previousBase;
    if (previousMax === undefined) delete process.env.AI_KEY_RETRY_MAX_MS;
    else process.env.AI_KEY_RETRY_MAX_MS = previousMax;
}

console.log('voiceTranscriptionFailoverV1883: ok');
