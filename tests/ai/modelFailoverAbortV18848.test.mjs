import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRuntimeModelFailover } from '../../src/features/ai/modelProviderFailover.js';

const candidate = {
    provider: 'compat',
    name: 'TEST_KEY',
    secret: 'test-secret',
    baseUrl: 'https://example.invalid/v1',
    model: 'gpt-test',
    mode: 'default',
};

test('V188.48: model retry/backoff stops immediately when operation is aborted', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const run = executeRuntimeModelFailover({
        candidates: [candidate],
        failuresBeforeQuarantine: 2,
        maxRounds: 0,
        useCredentialHealth: false,
        signal: controller.signal,
        request: async () => {
            attempts += 1;
            throw new Error('HTTP 503 temporary upstream failure');
        },
        sleep: () => new Promise(() => {}),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const error = new Error('supervisor timeout');
    error.code = 'OPERATION_TIMEOUT';
    controller.abort(error);
    await assert.rejects(run, (caught) => caught === error || caught?.code === 'OPERATION_TIMEOUT');
    assert.equal(attempts, 1, 'abort during retry backoff must prevent the next model attempt');
});
