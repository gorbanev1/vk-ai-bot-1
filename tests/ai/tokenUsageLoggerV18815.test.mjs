import assert from 'node:assert/strict';
import test from 'node:test';

import {
    inferAiTokenOperation,
    normalizeAiTokenUsage,
    recordAiTokenUsage,
    resetAiTokenUsageProcessTotals,
} from '../../src/features/ai/tokenUsageLogger.js';

test('V188.15 normalizes OpenAI and Responses-style token usage', () => {
    assert.deepEqual(
        normalizeAiTokenUsage({
            prompt_tokens: 120,
            completion_tokens: 45,
            total_tokens: 165,
            prompt_tokens_details: { cached_tokens: 30 },
            completion_tokens_details: { reasoning_tokens: 12 },
        }),
        {
            usageAvailable: true,
            inputTokens: 120,
            outputTokens: 45,
            totalTokens: 165,
            cachedTokens: 30,
            reasoningTokens: 12,
            audioInputTokens: 0,
            audioOutputTokens: 0,
        },
    );

    assert.equal(
        normalizeAiTokenUsage({ input_tokens: 9, output_tokens: 4, total_tokens: 13 }).totalTokens,
        13,
    );

    const gemini = normalizeAiTokenUsage({
        promptTokenCount: 40,
        candidatesTokenCount: 15,
        totalTokenCount: 60,
        cachedContentTokenCount: 10,
        thoughtsTokenCount: 5,
    });
    assert.equal(gemini.inputTokens, 40);
    assert.equal(gemini.outputTokens, 15);
    assert.equal(gemini.totalTokens, 60);
    assert.equal(gemini.cachedTokens, 10);
    assert.equal(gemini.reasoningTokens, 5);

    const anthropic = normalizeAiTokenUsage({
        input_tokens: 70,
        output_tokens: 20,
        cache_read_input_tokens: 12,
        cache_creation_input_tokens: 3,
    });
    assert.equal(anthropic.totalTokens, 90);
    assert.equal(anthropic.cachedTokens, 15);
});

test('V188.15 operation classifier keeps explicit labels and recognizes auto-summary', () => {
    assert.equal(inferAiTokenOperation({ operation: 'auto-summary:chunk' }), 'auto-summary:chunk');
    assert.equal(inferAiTokenOperation({ systemPrompt: 'Сделай авторезюме групповой беседы' }), 'auto-summary');
});

test('V188.15 logger marks missing provider usage as estimate instead of pretending it is exact', () => {
    resetAiTokenUsageProcessTotals();
    const row = recordAiTokenUsage({
        operation: 'test:no-usage',
        provider: 'compat',
        model: 'test-model',
        inputChars: 330,
        outputChars: 33,
        now: new Date('2026-09-09T00:00:00.000Z'),
    });
    assert.equal(row.usageSource, 'estimated');
    assert.equal(row.totalTokens, 0);
    assert.ok(row.estimatedTextTokens > 0);
});
