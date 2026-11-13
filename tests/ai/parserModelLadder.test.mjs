import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRuntimeModelFailover } from '../../src/features/ai/modelProviderFailover.js';
import { createParserModelSerialQueue, getGptModelLadderFrom, PARSER_MODEL_LADDER, POSTER_VISION_MODEL_LADDER, isRetiredParserModelError, isUnsupportedLunaReasoningError, parserModelAttempts, resolveParserLadderRuntimeModelId } from '../../src/features/ai/parserModelLadder.js';

test('starting at an explicit 5.6 model does not silently substitute another generation', () => {
    for (const model of ['gpt-5.6-luna', 'gpt-5.6-terra']) {
        assert.equal(getGptModelLadderFrom(model)[0].model, model);
    }
});

test('event parser ladder rises by screenshot quality/cost tiers and uses the requested retry budget', () => {
    assert.deepEqual(PARSER_MODEL_LADDER.map(({ model, attempts }) => [model, attempts]), [
        ['gpt-6-luna', 1],
        ['gpt-5.6-luna', 1],
        ['gpt-5.6-terra', 1],
        ['gpt-6.1-sol', 3],
        ['gpt-6-astra', 2],
    ]);
    assert.equal(PARSER_MODEL_LADDER.some(({ model }) => model === 'gpt-6-sol'), false);
    assert.equal(parserModelAttempts({ attemptLimit: 4 }), 4);
    assert.equal(isRetiredParserModelError(new Error('Model gpt-6-luna has been retired. Use gpt-6-luna instead.')), true);
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

test('poster vision uses the configured image ladder independently of text retries', async () => {
    assert.deepEqual(POSTER_VISION_MODEL_LADDER.map(({ model, detail, attempts }) => [model, detail, attempts]), [
        ['gpt-6-luna', 'high', 1],
        ['gpt-5.6-luna', 'high', 1],
        ['gpt-5.6-terra', 'high', 1],
        ['gpt-6.1-sol', 'original', 3],
        ['gpt-6-astra', 'original', 2],
    ]);

    const calls = [];
    const candidates = POSTER_VISION_MODEL_LADDER.map((entry) => ({
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
        sleep: async () => {},
        request: async (credential) => {
            calls.push(credential.model);
            if (credential.model === 'gpt-6-luna') throw new Error('GPT API 503: no providers available');
            return 'ok';
        },
    });

    assert.equal(result.value, 'ok');
    assert.deepEqual(calls, ['gpt-6-luna', 'gpt-5.6-luna']);
});

test('ordinary Vision reaches Astra last and succeeds on its second attempt', async () => {
    const calls = [];
    const candidates = POSTER_VISION_MODEL_LADDER.map((step) => ({ ...step,
        provider: 'compat', name: 'TEST', secret: 'test', baseUrl: 'https://example.invalid/v1' }));
    const result = await executeRuntimeModelFailover({
        candidates, maxRounds: 1, useCredentialHealth: false, attemptsForCandidate: parserModelAttempts,
        sleep: async () => {},
        request: async (candidate, { attempt }) => {
            calls.push(candidate.model);
            if (candidate.model === 'gpt-6-astra' && attempt === 2) return 'poster facts';
            throw new Error('GPT vision API 503: unavailable');
        },
    });
    assert.equal(result.value, 'poster facts');
    assert.deepEqual(calls, POSTER_VISION_MODEL_LADDER.flatMap((step) => Array(step.attempts).fill(step.model)));
});

test('explicit vision ladder model IDs bypass retired-generation alias normalization', () => {
    const normalize = (model) => model === 'gpt-5.6-terra' || model === 'gpt-5.6-luna'
        ? 'gpt-6-luna'
        : model === 'gpt-5.6-sol' ? 'gpt-6.1-sol' : model;

    assert.deepEqual(POSTER_VISION_MODEL_LADDER.slice(1, 4).map(({ model }) =>
        resolveParserLadderRuntimeModelId(model, { capability: 'vision', normalize })), [
        'gpt-5.6-luna',
        'gpt-5.6-terra',
        'gpt-6.1-sol',
    ]);
    assert.equal(resolveParserLadderRuntimeModelId('gpt-5.6-terra', { capability: 'text', normalize }), 'gpt-5.6-terra');
});

test('explicit 5.6 parser text models remain pinned instead of being normalized to 6.x', () => {
    const normalize = () => 'gpt-6-luna';
    assert.equal(resolveParserLadderRuntimeModelId('gpt-5.6-terra', { capability: 'text', normalize }), 'gpt-5.6-terra');
    assert.equal(resolveParserLadderRuntimeModelId('gpt-5.6-luna', { capability: 'text', normalize }), 'gpt-5.6-luna');
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

test('unsupported GPT-6 Luna low reasoning skips directly to the safe fallback', async () => {
    const unsupported = new Error('GPT API 400: reasoning_effort low is not supported by this model');
    assert.equal(isUnsupportedLunaReasoningError(unsupported, 'gpt-6-luna'), true);
    assert.equal(isUnsupportedLunaReasoningError(unsupported, 'gpt-5.6-luna'), false);
    assert.equal(isUnsupportedLunaReasoningError(new Error('GPT API 400: invalid image'), 'gpt-6-luna'), false);
    const calls = [];
    const result = await executeRuntimeModelFailover({
        candidates: PARSER_MODEL_LADDER.slice(0, 2).map((step) => ({
            ...step, provider: 'compat', name: 'TEST', secret: 'test',
            baseUrl: 'https://example.invalid/v1', attemptLimit: step.attempts,
        })),
        maxRounds: 1, useCredentialHealth: false, sleep: async () => {},
        shouldRetry: () => false,
        shouldAdvanceCandidate: (error, { credential }) =>
            isUnsupportedLunaReasoningError(error, credential.model),
        request: async (credential) => {
            calls.push(credential.model);
            if (credential.model === 'gpt-6-luna') throw unsupported;
            return 'ok';
        },
    });
    assert.equal(result.value, 'ok');
    assert.deepEqual(calls, ['gpt-6-luna', 'gpt-5.6-luna']);
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

test('a parser timeout rotates from Terra to the next configured model', async () => {
    const calls = [];
    const candidates = [
        { provider: 'compat', name: 'TEST_KEY', secret: 'test-secret', baseUrl: 'https://example.invalid/v1', model: 'gpt-5.6-terra', attemptLimit: 1 },
        { provider: 'compat', name: 'TEST_KEY', secret: 'test-secret', baseUrl: 'https://example.invalid/v1', model: 'gpt-6.1-sol', attemptLimit: 1 },
    ];
    const result = await executeRuntimeModelFailover({
        candidates, maxRounds: 1, useCredentialHealth: false, attemptsForCandidate: parserModelAttempts,
        request: async (credential) => {
            calls.push(credential.model);
            if (credential.model.endsWith('terra')) {
                const error = new Error('The operation was aborted due to timeout');
                error.name = 'TimeoutError';
                throw error;
            }
            return 'ok';
        },
    });
    assert.equal(result.value, 'ok');
    assert.deepEqual(calls, ['gpt-5.6-terra', 'gpt-6.1-sol']);
});
