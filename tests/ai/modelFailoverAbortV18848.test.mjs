import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRuntimeModelFailover, isTechnicalModelFailure } from '../../src/features/ai/modelProviderFailover.js';

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

test('request-local timeout and stream idle watchdog failures retry then advance the model ladder', async () => {
    assert.equal(isTechnicalModelFailure(new DOMException('GPT vision stream produced no bytes for 900000 ms', 'TimeoutError')), true);
    assert.equal(isTechnicalModelFailure(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' })), true);
    assert.equal(isTechnicalModelFailure(Object.assign(new Error('operation cancelled by owner'), { code: 'OPERATION_CANCELLED' })), false);
    assert.equal(isTechnicalModelFailure(Object.assign(new Error('operation deadline exceeded'), { code: 'OPERATION_TIMEOUT' })), false);

    const calls = [];
    const candidates = [candidate, { ...candidate, model: 'gpt-6.1-sol', mode: 'pro3' }];
    const result = await executeRuntimeModelFailover({
        candidates,
        failuresBeforeQuarantine: 3,
        maxRounds: 1,
        useCredentialHealth: false,
        sleep: async () => {},
        request: async (credential) => {
            calls.push(credential.model);
            if (credential.model === 'gpt-test') {
                throw new DOMException('GPT vision stream produced no bytes for 900000 ms', 'TimeoutError');
            }
            return 'recovered';
        },
    });

    assert.equal(result.value, 'recovered');
    assert.deepEqual(calls, ['gpt-test', 'gpt-test', 'gpt-test', 'gpt-6.1-sol']);
});
