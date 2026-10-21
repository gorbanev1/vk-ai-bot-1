import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { isRetryableOpenAITextError } from '../../src/features/ai/openAIRetryRouting.js';
import {
    executeRuntimeModelFailover,
    resetRuntimeModelCredentialHealth,
} from '../../src/features/ai/modelProviderFailover.js';

test('V188.53: incoming media normalizes vision-default before resolving a GPT model', async () => {
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

    assert.match(app, /const initialMode = resolveVisionMode\('vision-default'\);[\s\S]{0,200}const initialModel = await resolveGptModel\(initialMode\);/u);
    assert.doesNotMatch(app, /const initialMode = 'vision-default';\s*const initialModel = await resolveGptModel\(initialMode\);/u);
});

test('V188.53: universal incoming vision uses the complete finite advanced ladder', async () => {
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const mediaAnalyzer = app.slice(app.indexOf('async function analyzeIncomingMediaImage'), app.indexOf('async function getIncomingMediaAnalysis'));

    assert.match(mediaAnalyzer, /failoverMaxRounds:\s*1/u);
    assert.match(mediaAnalyzer, /failuresBeforeQuarantine:\s*2/u);
    assert.match(mediaAnalyzer, /maxCandidates:\s*0/u);
    assert.match(mediaAnalyzer, /escalateToAdvanced:\s*true/u);
});



test('V188.53: the final user-facing vision answer uses the same finite advanced ladder', async () => {
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const answerVision = app.slice(app.indexOf('async function answerVisionQuestion'), app.indexOf('function withActiveCommunicationTimeout'));

    assert.match(answerVision, /failoverMaxRounds:\s*1/u);
    assert.match(answerVision, /failuresBeforeQuarantine:\s*2/u);
    assert.match(answerVision, /maxCandidates:\s*0/u);
    assert.match(answerVision, /escalateToAdvanced:\s*true/u);
});
test('V188.53: vision capability/model errors advance instead of aborting the ladder', () => {
    assert.equal(
        isRetryableOpenAITextError(new Error('GPT vision API 400: model does not support image_url content')),
        true,
    );
    assert.equal(
        isRetryableOpenAITextError(new Error('GPT vision API 404: model gpt-x not found')),
        true,
    );
    assert.equal(
        isRetryableOpenAITextError(new Error('GPT vision API 503: upstream unavailable')),
        true,
    );
    assert.equal(
        isRetryableOpenAITextError(new Error('GPT vision API 400: malformed unrelated request field')),
        false,
    );
});

test('V188.53: two failures on one vision candidate move to the next model in the same finite round', async () => {
    resetRuntimeModelCredentialHealth();
    const calls = [];
    const candidates = [
        { provider: 'compat', name: 'KEY_A', secret: 'a', baseUrl: 'https://example.invalid/v1', model: 'gpt-5.4-mini', mode: 'default' },
        { provider: 'compat', name: 'KEY_A', secret: 'a', baseUrl: 'https://example.invalid/v1', model: 'gpt-5.4', mode: 'gpt54' },
    ];

    const result = await executeRuntimeModelFailover({
        candidates,
        failuresBeforeQuarantine: 2,
        maxRounds: 1,
        useCredentialHealth: false,
        shouldRetry: isRetryableOpenAITextError,
        sleep: async () => {},
        request: async (credential) => {
            calls.push(credential.model);
            if (credential.model === 'gpt-5.4-mini') {
                throw new Error('GPT vision API 400: model does not support image_url');
            }
            return 'ok';
        },
    });

    assert.equal(result.value, 'ok');
    assert.equal(result.credential.model, 'gpt-5.4');
    assert.deepEqual(calls, ['gpt-5.4-mini', 'gpt-5.4-mini', 'gpt-5.4']);
});

test('V188.53: media vision failover never loops after one requested round', async () => {
    resetRuntimeModelCredentialHealth();
    let calls = 0;
    const candidates = [
        { provider: 'compat', name: 'KEY_A', secret: 'a', baseUrl: 'https://example.invalid/v1', model: 'gpt-5.4-mini', mode: 'default' },
        { provider: 'compat', name: 'KEY_B', secret: 'b', baseUrl: 'https://example.invalid/v1', model: 'gpt-5.4', mode: 'gpt54' },
    ];

    await assert.rejects(() => executeRuntimeModelFailover({
        candidates,
        failuresBeforeQuarantine: 2,
        maxRounds: 1,
        useCredentialHealth: false,
        shouldRetry: isRetryableOpenAITextError,
        sleep: async () => {},
        request: async () => {
            calls += 1;
            throw new Error('GPT vision API 503: upstream unavailable');
        },
    }), /503/u);

    assert.equal(calls, 4);
});
