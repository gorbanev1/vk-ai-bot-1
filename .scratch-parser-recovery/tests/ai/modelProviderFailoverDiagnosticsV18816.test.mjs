import assert from 'node:assert/strict';
import test from 'node:test';

import {
    executeRuntimeModelFailover,
    resetRuntimeModelCredentialHealth,
} from '../../src/features/ai/modelProviderFailover.js';

const credential = {
    provider: 'compat',
    name: 'OPENAI_COMPAT_API_KEY',
    secret: 'test-secret',
    baseUrl: 'https://example.invalid/v1',
};

test('V188.16 all-quarantined failover preserves the prior technical reason', async () => {
    resetRuntimeModelCredentialHealth();
    await assert.rejects(
        executeRuntimeModelFailover({
            candidates: [credential],
            request: async () => {
                throw new Error('timeout while reading poster');
            },
            failuresBeforeQuarantine: 1,
            quarantineMs: 60_000,
            maxRounds: 1,
            sleep: async () => {},
        }),
        /timeout while reading poster/u,
    );

    await assert.rejects(
        executeRuntimeModelFailover({
            candidates: [credential],
            request: async () => 'should not run while quarantined',
            failuresBeforeQuarantine: 1,
            quarantineMs: 60_000,
            maxRounds: 1,
            sleep: async () => {},
        }),
        (error) => {
            assert.equal(error.code, 'AI_CREDENTIAL_QUARANTINED');
            assert.match(error.message, /timeout while reading poster/u);
            assert.doesNotMatch(error.message, /test-secret/u);
            return true;
        },
    );
    resetRuntimeModelCredentialHealth();
});
