import assert from 'node:assert/strict';
import {
    collectRuntimeModelCredentials,
    executeRuntimeModelFailover,
    resetRuntimeModelCredentialHealth,
    resolveProviderModel,
} from '../../src/features/ai/modelProviderFailover.js';

resetRuntimeModelCredentialHealth();
{
    const candidates = [
        { provider: 'compat', name: 'K1', secret: 'a', baseUrl: 'https://one.test' },
        { provider: 'compat', name: 'K2', secret: 'b', baseUrl: 'https://two.test' },
    ];
    const calls = [];
    const result = await executeRuntimeModelFailover({
        candidates,
        maxRounds: 1,
        quarantineMs: 60_000,
        sleep: async () => {},
        request: async (credential) => {
            calls.push(credential.name);
            if (credential.name === 'K1') throw new Error('GPT API 503: temporary');
            return 'ok';
        },
    });
    assert.equal(result.value, 'ok');
    assert.deepEqual(calls, ['K1', 'K1', 'K1', 'K2']);
}

resetRuntimeModelCredentialHealth();
{
    const calls = [];
    await assert.rejects(() => executeRuntimeModelFailover({
        candidates: [
            { provider: 'compat', name: 'K1', secret: 'a', baseUrl: 'https://one.test' },
            { provider: 'compat', name: 'K2', secret: 'b', baseUrl: 'https://two.test' },
        ],
        maxRounds: 1,
        sleep: async () => {},
        request: async (credential) => {
            calls.push(credential.name);
            throw new Error('GPT API 400: invalid request body');
        },
    }), /400/u);
    assert.deepEqual(calls, ['K1']);
}

{
    const env = {
        AI_PROVIDER_ORDER: 'xai,compat',
        XAI_API_KEY: 'xai-test-key',
        OPENAI_COMPAT_API_KEY: 'router-key',
        OPENAI_COMPAT_BASE_URL: 'https://router.example/v1',
        XAI_MODEL_DEFAULT: 'grok-4.6',
    };
    const rows = collectRuntimeModelCredentials(env);
    assert.equal(rows[0].provider, 'xai');
    assert.equal(rows[1].provider, 'compat');
    assert.equal(resolveProviderModel({ credential: rows[0], mode: 'default', requestedModel: 'gpt-5.4-mini', env }), 'grok-4.6');
    assert.equal(resolveProviderModel({ credential: rows[1], mode: 'default', requestedModel: 'gpt-5.4-mini', env }), 'gpt-5.4-mini');
}

console.log('modelProviderFailoverV1883: ok');
