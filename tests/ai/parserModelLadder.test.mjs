import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRuntimeModelFailover } from '../../src/features/ai/modelProviderFailover.js';
import { createParserModelSerialQueue, PARSER_MODEL_LADDER, isRetiredParserModelError, parserModelAttempts } from '../../src/features/ai/parserModelLadder.js';

test('event parser ladder rises by screenshot quality/cost tiers and uses the requested retry budget', () => {
    assert.deepEqual(PARSER_MODEL_LADDER.map(({ model, attempts }) => [model, attempts]), [
        ['gpt-6-luna', 4],
        ['gpt-6.1-sol', 3],
        ['gpt-6-astra', 2],
    ]);
    assert.equal(PARSER_MODEL_LADDER.some(({ model }) => model === 'gpt-6-sol'), false);
    assert.equal(parserModelAttempts({ attemptLimit: 4 }), 4);
    assert.equal(isRetiredParserModelError(new Error('Model gpt-5.4-mini has been retired. Use gpt-6-luna instead.')), true);
    assert.equal(isRetiredParserModelError(new Error('GPT API 503: no providers are available')), false);
});

test('event parser exhausts only the configured attempts before advancing to the next model', async () => {
    const calls = [];
    const candidates = PARSER_MODEL_LADDER.map((entry) => ({
        provider: 'compat',
        name: 'TEST_KEY',
        secret: 'test-secret',
        baseUrl: 'https://example.invalid/v1',
        model: entry.model,
        mode: entry.mode,
        attemptLimit: entry.attempts,
    }));
    await assert.rejects(executeRuntimeModelFailover({
        candidates,
        maxRounds: 1,
        useCredentialHealth: false,
        attemptsForCandidate: parserModelAttempts,
        shouldRetry: () => true,
        sleep: async () => {},
        request: async (credential) => {
            calls.push(credential.model);
            throw new Error('GPT API 503: provider unavailable');
        },
    }));

    assert.deepEqual(calls, PARSER_MODEL_LADDER.flatMap(({ model, attempts }) => Array(attempts).fill(model)));
});

test('a successful parser model stops the ladder without invoking more expensive models', async () => {
    const calls = [];
    const [first, ...rest] = PARSER_MODEL_LADDER;
    const candidates = PARSER_MODEL_LADDER.map((entry) => ({
        provider: 'compat',
        name: 'TEST_KEY',
        secret: 'test-secret',
        baseUrl: 'https://example.invalid/v1',
        ...entry,
        attemptLimit: entry.attempts,
    }));
    const result = await executeRuntimeModelFailover({
        candidates,
        maxRounds: 1,
        useCredentialHealth: false,
        attemptsForCandidate: parserModelAttempts,
        shouldRetry: () => true,
        request: async (credential) => {
            calls.push(credential.model);
            if (credential.model === first.model) throw new Error('GPT API 503: temporary provider outage');
            return 'ok';
        },
    });

    assert.equal(result.value, 'ok');
    assert.deepEqual(calls, [
        ...Array(first.attempts).fill(first.model),
        rest[0].model,
    ]);
});

test('parser vision queue never runs two image requests at once', async () => {
    const enqueue = createParserModelSerialQueue();
    const order = [];
    let active = 0;
    let peak = 0;
    const run = (index, delayMs) => enqueue(async () => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(`start-${index}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(`end-${index}`);
        active -= 1;
        return index;
    });

    assert.deepEqual(await Promise.all([run(1, 10), run(2, 1), run(3, 1)]), [1, 2, 3]);
    assert.equal(peak, 1);
    assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
});

test('a retired parser model advances immediately without spending its retry budget', async () => {
    const calls = [];
    const [retired, next] = PARSER_MODEL_LADDER;
    const candidates = [retired, next].map((entry) => ({
        provider: 'compat',
        name: 'TEST_KEY',
        secret: 'test-secret',
        baseUrl: 'https://example.invalid/v1',
        ...entry,
        attemptLimit: entry.attempts,
    }));
    const result = await executeRuntimeModelFailover({
        candidates,
        maxRounds: 1,
        useCredentialHealth: false,
        attemptsForCandidate: parserModelAttempts,
        shouldRetry: () => true,
        shouldAdvanceCandidate: isRetiredParserModelError,
        request: async (credential) => {
            calls.push(credential.model);
            if (credential.model === retired.model) throw new Error('Model gpt-6-luna has been retired.');
            return 'ok';
        },
    });

    assert.equal(result.value, 'ok');
    assert.deepEqual(calls, [retired.model, next.model]);
});
