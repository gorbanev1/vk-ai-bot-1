import assert from 'node:assert/strict';

import {
    executeOpenAIModelChainRecovery,
    executeOpenAITextRecovery,
    getNextAdvancedGptModes,
    isRetryableOpenAITextError,
    selectOpenAIRetryDelayMs,
} from '../../src/features/ai/openAIRetryRouting.js';

assert.equal(selectOpenAIRetryDelayMs(() => 0), 5_000);
assert.equal(selectOpenAIRetryDelayMs(() => 0.999999999), 30_000);
assert.ok(selectOpenAIRetryDelayMs(() => 0.5) >= 17_500);
assert.ok(selectOpenAIRetryDelayMs(() => 0.5) <= 17_501);

assert.deepEqual(
    getNextAdvancedGptModes('default'),
    ['gpt54', 'gpt55', 'pro', 'pro2', 'pro3'],
);
assert.deepEqual(getNextAdvancedGptModes('pro'), ['pro2', 'pro3']);
assert.deepEqual(getNextAdvancedGptModes('pro3'), []);

assert.equal(
    isRetryableOpenAITextError(
        new Error('GPT API 404: Model gpt-5.4-mini is not available. Use GET /v1/models to list available models.'),
    ),
    true,
);
assert.equal(isRetryableOpenAITextError(new Error('GPT API 503: upstream busy')), true);
assert.equal(isRetryableOpenAITextError(new Error('GPT network error: fetch failed')), true);
assert.equal(isRetryableOpenAITextError(new Error('GPT API 401: invalid api key')), false);
assert.equal(isRetryableOpenAITextError(new Error('GPT API 400: content is invalid')), false);
assert.equal(isRetryableOpenAITextError(new Error('GPT vision API 400: image input is not supported by this model')), true);


const calls = [];
const events = [];
const recovered = await executeOpenAITextRecovery({
    initialModel: 'gpt-5.4-mini',
    random: () => 0,
    sleep: async (delayMs) => {
        assert.equal(delayMs, 5_000);
    },
    request: async (model) => {
        calls.push(model);
        if (calls.length <= 2) {
            throw new Error(`GPT API 404: Model ${model} is not available`);
        }
        return 'готово';
    },
    resolveFallback: async () => ({
        mode: 'gpt54',
        model: 'gpt-5.4',
    }),
    onEvent: (event) => events.push(event.type),
});
assert.deepEqual(calls, ['gpt-5.4-mini', 'gpt-5.4-mini', 'gpt-5.4']);
assert.deepEqual(events, ['retry', 'fallback']);
assert.equal(recovered.value, 'готово');
assert.equal(recovered.model, 'gpt-5.4');
assert.equal(recovered.mode, 'gpt54');
assert.equal(recovered.recovery, 'advanced-model-fallback');

let sameModelAttempts = 0;
const sameModelRecovered = await executeOpenAITextRecovery({
    initialModel: 'gpt-5.6-luna',
    random: () => 0.5,
    sleep: async () => {},
    request: async () => {
        sameModelAttempts += 1;
        if (sameModelAttempts === 1) {
            throw new Error('GPT API 503: temporarily busy');
        }
        return 'ответ';
    },
});
assert.equal(sameModelAttempts, 2);
assert.equal(sameModelRecovered.model, 'gpt-5.6-luna');
assert.equal(sameModelRecovered.recovery, 'same-model-retry');


const chainCalls = [];
const chainEvents = [];
const chainRecovered = await executeOpenAIModelChainRecovery({
    candidates: [
        { mode: 'default', model: 'gpt-5.4-mini' },
        { mode: 'gpt54', model: 'gpt-5.4' },
        { mode: 'gpt55', model: 'gpt-5.5' },
        { mode: 'pro', model: 'gpt-5.6-luna' },
        { mode: 'pro2', model: 'gpt-5.6-terra' },
        { mode: 'pro3', model: 'gpt-5.6-sol' },
    ],
    random: () => 0,
    sleep: async (delayMs) => {
        assert.equal(delayMs, 5_000);
    },
    request: async (model) => {
        chainCalls.push(model);

        if (model !== 'gpt-5.6-terra') {
            throw new Error(
                `GPT vision API 400: image input is not supported by ${model}`,
            );
        }

        return 'изображение распознано';
    },
    onEvent: (event) => chainEvents.push(event.type),
});
assert.deepEqual(chainCalls, [
    'gpt-5.4-mini',
    'gpt-5.4-mini',
    'gpt-5.4',
    'gpt-5.4',
    'gpt-5.5',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
]);
assert.deepEqual(chainEvents, [
    'retry', 'fallback',
    'retry', 'fallback',
    'retry', 'fallback',
    'retry', 'fallback',
]);
assert.equal(chainRecovered.model, 'gpt-5.6-terra');
assert.equal(chainRecovered.mode, 'pro2');
assert.equal(chainRecovered.value, 'изображение распознано');
assert.equal(chainRecovered.recovery, 'model-chain-fallback');

console.log('openAIRetryRouting tests: OK');
