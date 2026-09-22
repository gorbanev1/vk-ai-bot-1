import test from 'node:test';
import assert from 'node:assert/strict';

import {
    executeRuntimeModelFailover,
    resetRuntimeModelCredentialHealth,
} from '../../src/features/ai/modelProviderFailover.js';

test('V188.58: failure of mini quarantines only mini, not the next model on the same key', async () => {
    resetRuntimeModelCredentialHealth();
    const calls = [];
    const events = [];
    const candidates = [
        { provider: 'compat', name: 'OPENAI_COMPAT_API_KEY', secret: 'x', baseUrl: 'https://example.invalid/v1', model: 'gpt-5.4-mini', mode: 'default', capability: 'vision' },
        { provider: 'compat', name: 'OPENAI_COMPAT_API_KEY', secret: 'x', baseUrl: 'https://example.invalid/v1', model: 'gpt-5.4', mode: 'gpt54', capability: 'vision' },
    ];

    const result = await executeRuntimeModelFailover({
        candidates,
        failuresBeforeQuarantine: 1,
        maxRounds: 1,
        quarantineMs: 60_000,
        useCredentialHealth: true,
        sleep: async () => {},
        onEvent: (event) => events.push({ type: event.type, model: event.credential?.model || '' }),
        request: async (credential) => {
            calls.push(credential.model);
            if (credential.model === 'gpt-5.4-mini') throw new Error('timeout');
            return 'ok';
        },
    });

    assert.equal(result.value, 'ok');
    assert.equal(result.credential.model, 'gpt-5.4');
    assert.deepEqual(calls, ['gpt-5.4-mini', 'gpt-5.4']);
    assert.ok(events.some((row) => row.type === 'rotate' && row.model === 'gpt-5.4-mini'));
    assert.ok(events.some((row) => row.type === 'success' && row.model === 'gpt-5.4'));
    assert.equal(events.some((row) => row.type === 'skip-quarantined' && row.model === 'gpt-5.4'), false);
});

test('V188.58: capability scope is independent for the same provider key/model', async () => {
    resetRuntimeModelCredentialHealth();
    const base = { provider: 'compat', name: 'KEY', secret: 'x', baseUrl: 'https://example.invalid/v1', model: 'gpt-5.4-mini' };

    await assert.rejects(() => executeRuntimeModelFailover({
        candidates: [{ ...base, capability: 'vision' }],
        failuresBeforeQuarantine: 1,
        maxRounds: 1,
        quarantineMs: 60_000,
        useCredentialHealth: true,
        sleep: async () => {},
        request: async () => { throw new Error('vision timeout'); },
    }), /vision timeout/u);

    let textCalls = 0;
    const textResult = await executeRuntimeModelFailover({
        candidates: [{ ...base, capability: 'text' }],
        failuresBeforeQuarantine: 1,
        maxRounds: 1,
        quarantineMs: 60_000,
        useCredentialHealth: true,
        sleep: async () => {},
        request: async () => { textCalls += 1; return 'text-ok'; },
    });

    assert.equal(textResult.value, 'text-ok');
    assert.equal(textCalls, 1);
});
